import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { fetchStreetsFromTiles } from './tiles.js';
import { buildSTL } from './export.js';
import { GUI, createParams, createPresetStore, createStats, effect, untrack, signal, bindKey, easings } from 'guspira';

const OVERPASS = [
	'https://overpass-api.de/api/interpreter',
	'https://overpass.private.coffee/api/interpreter',
	'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const TERRAIN = ( z, x, y ) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const DEG = Math.PI / 180;

const CITIES = [
	[ 'Edinburgh', 55.9496, -3.1906 ],
	[ 'Prague', 50.0875, 14.4213 ],
	[ 'Porto', 41.1408, -8.6131 ],
	[ 'Barcelona', 41.3870, 2.1701 ],
	[ 'Venice', 45.4380, 12.3359 ],
	[ 'Paris', 48.8738, 2.2950 ],
	[ 'Manhattan', 40.7308, -73.9973 ],
	[ 'San Francisco', 37.7930, -122.4161 ],
	[ 'Kyoto', 35.0037, 135.7788 ],
	[ 'Fès', 34.0646, -4.9730 ],
];

const $ = ( id ) => document.getElementById( id );
const statusEl = $( 'status' );

// One typed store for every setting: saved between visits, overridable from the URL (?style=lines),
// and the looks ease between values instead of jumping.
const params = createParams( {
	source: 'tiles',
	radius: 1200,
	algorithm: 'main',
	count: 150,
	layout: 'ring',
	bundling: .6,
	style: 'particles',
	aperture: 6,
	size: 1,
	terrain: 2,
	cold: '#5280ff',
	warm: '#ffcc8c',
	background: '#05060a',
	grow: 5,
	pulse: true,
	rotate: true,
	printSize: 150,
	printBase: 'relief',
}, {
	storageKey: 'urban-arteries',
	url: true,
	ease: { duration: 450, easing: easings.cubicOut, only: [ 'aperture', 'size', 'terrain', 'cold', 'warm', 'background' ] },
} );

const sceneRadius = signal( 1200 );
const info = { nodes: signal( 0 ), segments: signal( 0 ), destinations: signal( 0 ), load: signal( 0 ), routing: signal( 0 ), exported: signal( '—' ) };

function setStatus( text, error = false ) {
	statusEl.textContent = text;
	statusEl.classList.toggle( 'error', error );
}

// One bar for the whole load; it only moves forward, and creeps while a server gives no measurable progress.
const progress = {
	el: $( 'progress' ),
	value: 0,
	timer: 0,
	reset() {
		this.stop();
		this.value = 0;
		this.el.className = 'reset';
		this.el.style.setProperty( '--p', 0 );
		this.el.offsetWidth;
		this.el.className = 'active';
	},
	set( v ) {
		this.value = Math.max( this.value, Math.min( v, 1 ) );
		this.el.style.setProperty( '--p', this.value );
	},
	creep( from, to, seconds ) {
		this.stop();
		const t0 = performance.now();
		this.timer = setInterval( () => this.set( from + ( to - from ) * ( 1 - Math.exp( - ( performance.now() - t0 ) / 1000 / seconds ) ) ), 100 );
	},
	stop() {
		clearInterval( this.timer );
	},
	done() {
		this.stop();
		this.set( 1 );
		this.el.className = 'done';
	},
	fail() {
		this.stop();
		this.el.className = 'error';
	},
};

const MB = ( bytes ) => ( bytes / 1048576 ).toFixed( 1 ) + ' MB';
const nextFrame = () => new Promise( ( r ) => requestAnimationFrame( () => setTimeout( r ) ) );

// ---------------------------------------------------------------- data

async function geocode( query ) {
	const m = query.match( /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/ );
	if ( m ) return { lat: +m[ 1 ], lon: +m[ 2 ], name: query.trim() };
	const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' + encodeURIComponent( query );
	const res = await fetch( url, { headers: { 'Accept-Language': navigator.language } } );
	if ( ! res.ok ) throw new Error( `Search failed (${res.status})` );
	const [ hit ] = await res.json();
	if ( ! hit ) throw new Error( `Nothing found for “${query}”` );
	return { lat: +hit.lat, lon: +hit.lon, name: hit.display_name.split( ',' )[ 0 ] };
}

async function fetchStreets( lat, lon, radius, signal, onProgress ) {
	const query = `[out:json][timeout:60];
way["highway"]["highway"!~"^(motorway|motorway_link|construction|proposed|abandoned|raceway|bus_guideway|platform|escape)$"]
	["foot"!="no"]["access"!~"^(private|no)$"]["footway"!~"^(sidewalk|crossing)$"]["service"!~"^(parking_aisle|driveway)$"](around:${radius},${lat},${lon});
out body qt;
>;
out skel qt;`;
	const key = 'https://overpass.cache/?' + encodeURIComponent( query );
	const cache = await caches?.open( 'urban-arteries' ).catch( () => null );
	const hit = await cache?.match( key );
	if ( hit ) return ( await hit.json() ).elements;

	const errors = [];
	for ( const endpoint of OVERPASS ) {
		try {
			onProgress( { host: new URL( endpoint ).host, bytes: 0 } );
			const res = await fetch( endpoint, {
				method: 'POST',
				body: 'data=' + encodeURIComponent( query ),
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				signal,
			} );
			if ( ! res.ok ) throw new Error( `${new URL( endpoint ).host}: ${res.status}` );
			const chunks = [];
			let bytes = 0;
			for ( const reader = res.body.getReader(); ; ) {
				const { done, value } = await reader.read();
				if ( done ) break;
				chunks.push( value );
				bytes += value.length;
				onProgress( { host: new URL( endpoint ).host, bytes } );
			}
			const text = await new Blob( chunks ).text();
			cache?.put( key, new Response( text ) ).catch( () => {} );
			return JSON.parse( text ).elements;
		} catch ( e ) {
			if ( signal.aborted ) throw e;
			errors.push( e.message );
		}
	}
	throw new Error( `Street data servers are busy, try again in a minute (${errors.join( '; ' )})` );
}

// Terrarium tiles encode height as (R * 256 + G + B / 256) - 32768 metres.
async function loadElevation( lats, lons, zoom, inArea, signal, onProgress ) {
	const n = 2 ** zoom;
	const px = ( lon ) => ( lon + 180 ) / 360 * n * 256;
	const py = ( lat ) => ( 1 - Math.log( Math.tan( lat * DEG ) + 1 / Math.cos( lat * DEG ) ) / Math.PI ) / 2 * n * 256;

	let minX = Infinity, maxX = - Infinity, minY = Infinity, maxY = - Infinity;
	for ( let i = 0; i < lats.length; i ++ ) {
		if ( ! inArea( i ) ) continue;
		const x = px( lons[ i ] ), y = py( lats[ i ] );
		minX = Math.min( minX, x ); maxX = Math.max( maxX, x );
		minY = Math.min( minY, y ); maxY = Math.max( maxY, y );
	}
	const tx0 = Math.floor( minX / 256 ), tx1 = Math.floor( ( maxX + 1 ) / 256 );
	const ty0 = Math.floor( minY / 256 ), ty1 = Math.floor( ( maxY + 1 ) / 256 );
	const w = ( tx1 - tx0 + 1 ) * 256, h = ( ty1 - ty0 + 1 ) * 256;
	const canvas = new OffscreenCanvas( w, h );
	const ctx = canvas.getContext( '2d', { willReadFrequently: true } );

	const jobs = [];
	const total = ( tx1 - tx0 + 1 ) * ( ty1 - ty0 + 1 );
	let loaded = 0;
	onProgress( 0, total );
	for ( let ty = ty0; ty <= ty1; ty ++ ) for ( let tx = tx0; tx <= tx1; tx ++ ) {
		jobs.push( fetch( TERRAIN( zoom, tx, ty ), { signal } )
			.then( ( r ) => r.blob() )
			.then( createImageBitmap )
			.then( ( img ) => {
				ctx.drawImage( img, ( tx - tx0 ) * 256, ( ty - ty0 ) * 256 );
				onProgress( ++ loaded, total );
			} ) );
	}
	await Promise.all( jobs );
	const data = ctx.getImageData( 0, 0, w, h ).data;
	const heightAt = ( x, y ) => {
		x = Math.min( Math.max( x, 0 ), w - 1 );
		y = Math.min( Math.max( y, 0 ), h - 1 );
		const o = ( y * w + x ) * 4;
		return data[ o ] * 256 + data[ o + 1 ] + data[ o + 2 ] / 256 - 32768;
	};

	const sample = ( lat, lon ) => {
		const x = px( lon ) - tx0 * 256 - .5, y = py( lat ) - ty0 * 256 - .5;
		const x0 = Math.floor( x ), y0 = Math.floor( y ), fx = x - x0, fy = y - y0;
		const a = heightAt( x0, y0 ) * ( 1 - fx ) + heightAt( x0 + 1, y0 ) * fx;
		const b = heightAt( x0, y0 + 1 ) * ( 1 - fx ) + heightAt( x0 + 1, y0 + 1 ) * fx;
		return a * ( 1 - fy ) + b * fy;
	};
	return { heights: Float32Array.from( lats, ( lat, i ) => sample( lat, lons[ i ] ) ), sample };
}

// ---------------------------------------------------------------- graph

// Walking cost multipliers per highway class: lower means a route prefers it, like a main street.
const HIGHWAY_COST = {
	pedestrian: .8, primary: .85, secondary: .85, tertiary: .9, trunk: .95,
	primary_link: .9, secondary_link: .9, tertiary_link: .95, trunk_link: 1,
	living_street: 1, unclassified: 1.05, residential: 1.1, footway: 1.15,
	cycleway: 1.2, path: 1.25, steps: 1.3, track: 1.4, bridleway: 1.4, service: 1.5,
};

function buildGraph( elements, lat0, lon0 ) {
	const kx = 111320 * Math.cos( lat0 * DEG ), kz = 110540;
	const index = new Map();
	const lats = [], lons = [], xs = [], zs = [];
	for ( const el of elements ) {
		if ( el.type !== 'node' ) continue;
		index.set( el.id, lats.length );
		lats.push( el.lat ); lons.push( el.lon );
		xs.push( ( el.lon - lon0 ) * kx );
		zs.push( - ( el.lat - lat0 ) * kz );
	}
	const n = lats.length;
	const ea = [], eb = [], ec = [];
	for ( const el of elements ) {
		if ( el.type !== 'way' ) continue;
		const highway = el.tags?.highway;
		if ( highway === 'corridor' ) continue;
		if ( highway === 'cycleway' && ! /^(yes|designated|permissive)$/.test( el.tags.foot ) ) continue;
		const cost = HIGHWAY_COST[ highway ] ?? 1.2;
		for ( let i = 1; i < el.nodes.length; i ++ ) {
			const a = index.get( el.nodes[ i - 1 ] ), b = index.get( el.nodes[ i ] );
			if ( a === undefined || b === undefined || a === b ) continue;
			ea.push( a ); eb.push( b ); ec.push( cost );
		}
	}

	// Compressed adjacency, both directions: walking ignores oneway.
	const m = ea.length;
	const offset = new Int32Array( n + 1 );
	for ( let i = 0; i < m; i ++ ) { offset[ ea[ i ] + 1 ] ++; offset[ eb[ i ] + 1 ] ++; }
	for ( let i = 0; i < n; i ++ ) offset[ i + 1 ] += offset[ i ];
	const fill = offset.slice( 0, n );
	const adj = new Int32Array( m * 2 ), edge = new Int32Array( m * 2 );
	const len = new Float32Array( m ), cost = new Float32Array( ec );
	for ( let i = 0; i < m; i ++ ) {
		const a = ea[ i ], b = eb[ i ];
		len[ i ] = Math.hypot( xs[ a ] - xs[ b ], zs[ a ] - zs[ b ] );
		adj[ fill[ a ] ] = b; edge[ fill[ a ] ++ ] = i;
		adj[ fill[ b ] ] = a; edge[ fill[ b ] ++ ] = i;
	}
	// Marks every substantial connected piece, so the origin never lands on an isolated footpath
	// but an island city is not traded for a bigger mainland network.
	const root = Int32Array.from( { length: n }, ( _, i ) => i );
	const find = ( i ) => { while ( root[ i ] !== i ) i = root[ i ] = root[ root[ i ] ]; return i; };
	for ( let i = 0; i < m; i ++ ) root[ find( ea[ i ] ) ] = find( eb[ i ] );
	const size = new Int32Array( n );
	let biggest = 0;
	for ( let i = 0; i < n; i ++ ) if ( ++ size[ find( i ) ] > size[ biggest ] ) biggest = find( i );
	const connected = Uint8Array.from( { length: n }, ( _, i ) => size[ find( i ) ] >= size[ biggest ] * .15 ? 1 : 0 );

	return { n, m, lats, lons, xs, zs, offset, adj, edge, len, cost, connected, lat0, lon0, kx, kz };
}

// Dijkstra over per-edge weights; turnPenalty (metres) discourages grid zigzags, and it stops once all goals are settled.
function shortestPathTree( g, source, weight, turnPenalty = 0, goals = null ) {
	const goal = goals && new Uint8Array( g.n );
	let left = 0;
	if ( goals ) for ( const v of goals ) if ( ! goal[ v ] ) { goal[ v ] = 1; left ++; }
	const dist = new Float64Array( g.n ).fill( Infinity );
	const parent = new Int32Array( g.n ).fill( - 1 );
	const parentEdge = new Int32Array( g.n ).fill( - 1 );
	const order = [];
	const hk = [], hv = [];
	const push = ( k, v ) => {
		let i = hk.length;
		hk.push( k ); hv.push( v );
		while ( i > 0 ) {
			const p = ( i - 1 ) >> 1;
			if ( hk[ p ] <= k ) break;
			hk[ i ] = hk[ p ]; hv[ i ] = hv[ p ]; i = p;
		}
		hk[ i ] = k; hv[ i ] = v;
	};
	const pop = () => {
		const v = hv[ 0 ], lk = hk.pop(), lv = hv.pop();
		const size = hk.length;
		if ( size ) {
			let i = 0;
			for ( ;; ) {
				let c = 2 * i + 1;
				if ( c >= size ) break;
				if ( c + 1 < size && hk[ c + 1 ] < hk[ c ] ) c ++;
				if ( hk[ c ] >= lk ) break;
				hk[ i ] = hk[ c ]; hv[ i ] = hv[ c ]; i = c;
			}
			hk[ i ] = lk; hv[ i ] = lv;
		}
		return v;
	};

	const { xs, zs } = g;
	dist[ source ] = 0;
	push( 0, source );
	const done = new Uint8Array( g.n );
	while ( hk.length ) {
		const u = pop();
		if ( done[ u ] ) continue;
		done[ u ] = 1;
		order.push( u );
		if ( goal && goal[ u ] && -- left === 0 ) break;
		const p = parent[ u ];
		for ( let h = g.offset[ u ]; h < g.offset[ u + 1 ]; h ++ ) {
			const w = weight[ g.edge[ h ] ];
			if ( w === Infinity ) continue;
			const v = g.adj[ h ];
			let d = dist[ u ] + w;
			if ( turnPenalty && p >= 0 ) {
				const ax = xs[ u ] - xs[ p ], az = zs[ u ] - zs[ p ], bx = xs[ v ] - xs[ u ], bz = zs[ v ] - zs[ u ];
				const c = ( ax * bx + az * bz ) / ( Math.hypot( ax, az ) * Math.hypot( bx, bz ) + 1e-9 );
				if ( c < .8 ) d += turnPenalty * ( 1 - c ) * .5;
			}
			if ( d < dist[ v ] ) { dist[ v ] = d; parent[ v ] = u; parentEdge[ v ] = g.edge[ h ]; push( d, v ); }
		}
	}
	return { dist, parent, parentEdge, order };
}

function nearestNode( g, x, z, usable = null ) {
	let best = - 1, bestD = Infinity;
	for ( let i = 0; i < g.n; i ++ ) {
		if ( g.offset[ i + 1 ] === g.offset[ i ] || ( usable && ! usable[ i ] ) ) continue;
		const d = ( g.xs[ i ] - x ) ** 2 + ( g.zs[ i ] - z ) ** 2;
		if ( d < bestD ) { bestD = d; best = i; }
	}
	return best;
}

function seededRandom( seed ) {
	return () => {
		seed = ( seed + 0x6D2B79F5 ) | 0;
		let t = Math.imul( seed ^ ( seed >>> 15 ), 1 | seed );
		t = ( t + Math.imul( t ^ ( t >>> 7 ), 61 | t ) ) ^ t;
		return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;
	};
}

// Ring: the farthest reachable street in each of `count` sectors, which is the radius or wherever the city ends
// first, like a coastline. Scattered: random reachable streets inside the radius.
function pickTargets( g, reachable, radius, count, layout ) {
	const random = seededRandom( count * 7919 + ( layout === 'ring' ? 1 : 2 ) );
	if ( layout === 'ring' ) {
		const best = new Int32Array( count ).fill( - 1 ), far = new Float64Array( count );
		const turn = random() * 2 * Math.PI;
		for ( let i = 0; i < g.n; i ++ ) {
			if ( ! reachable[ i ] ) continue;
			const d = Math.hypot( g.xs[ i ], g.zs[ i ] );
			if ( d > radius ) continue;
			const a = ( Math.atan2( g.zs[ i ], g.xs[ i ] ) + turn + 4 * Math.PI ) % ( 2 * Math.PI );
			const k = Math.min( count - 1, Math.floor( a / ( 2 * Math.PI ) * count ) );
			if ( d > far[ k ] ) { far[ k ] = d; best[ k ] = i; }
		}
		return [ ...new Set( best.filter( ( i ) => i >= 0 ) ) ];
	}
	const inside = [];
	for ( let i = 0; i < g.n; i ++ ) if ( reachable[ i ] && Math.hypot( g.xs[ i ], g.zs[ i ] ) <= radius ) inside.push( i );
	const targets = new Set();
	for ( let j = 0; j < count * 4 && targets.size < Math.min( count, inside.length ); j ++ ) targets.add( inside[ Math.floor( random() * inside.length ) ] );
	return [ ...targets ];
}

// Returns the drawn edges, oriented away from the source, with how many destinations use each one.
async function route( g, source, { algorithm, radius, count, layout, bundling }, onRound, cancelled ) {
	const flow = new Float32Array( g.m );

	if ( algorithm === 'all' ) {
		const tree = shortestPathTree( g, source, g.len );
		const through = new Float32Array( g.n );
		for ( let i = tree.order.length - 1; i > 0; i -- ) {
			const v = tree.order[ i ];
			if ( Math.hypot( g.xs[ v ], g.zs[ v ] ) <= radius ) through[ v ] += 1;
			through[ tree.parent[ v ] ] += through[ v ];
			flow[ tree.parentEdge[ v ] ] = through[ v ];
		}
		return collect( g, source, flow, 0 );
	}

	const preferred = algorithm === 'main';
	const base = preferred ? g.len.map( ( l, e ) => l * g.cost[ e ] ) : g.len;
	const first = shortestPathTree( g, source, base );
	const reachable = first.dist.map( ( d ) => d < Infinity ? 1 : 0 );
	const targets = pickTargets( g, reachable, radius, count, layout );

	// Route in rounds; streets used by earlier rounds get cheaper, so later routes merge into them.
	const rounds = preferred && bundling > 0 ? Math.min( 32, targets.length ) : 1;
	const weight = new Float32Array( base );
	const random = seededRandom( targets.length );
	for ( let i = targets.length - 1; i > 0; i -- ) {
		const j = Math.floor( random() * ( i + 1 ) );
		[ targets[ i ], targets[ j ] ] = [ targets[ j ], targets[ i ] ];
	}
	const turn = preferred ? 20 : 0;
	for ( let r = 0; r < rounds; r ++ ) {
		const from = Math.floor( r * targets.length / rounds ), to = Math.floor( ( r + 1 ) * targets.length / rounds );
		const tree = r === 0 && ! turn ? first : shortestPathTree( g, source, weight, turn, targets.slice( from, to ) );
		for ( let i = from; i < to; i ++ ) {
			for ( let v = targets[ i ]; v !== source && tree.parent[ v ] >= 0; v = tree.parent[ v ] ) flow[ tree.parentEdge[ v ] ] ++;
		}
		for ( let e = 0; e < g.m; e ++ ) {
			if ( flow[ e ] ) weight[ e ] = base[ e ] * ( 1 - bundling * .95 * ( 1 - Math.exp( - flow[ e ] / .5 ) ) );
		}
		onRound( r + 1, rounds );
		await new Promise( ( resolve ) => setTimeout( resolve ) );
		if ( cancelled() ) return null;
	}
	return collect( g, source, flow, targets.length );
}

function collect( g, source, flow, targets ) {
	const only = flow.map( ( f, e ) => f > 0 ? g.len[ e ] : Infinity );
	const { dist } = shortestPathTree( g, source, only );
	const segs = [];
	let maxFlow = 1, maxDist = 0;
	for ( let u = 0; u < g.n; u ++ ) {
		for ( let h = g.offset[ u ]; h < g.offset[ u + 1 ]; h ++ ) {
			const v = g.adj[ h ], e = g.edge[ h ];
			if ( ! ( flow[ e ] > 0 ) || ! ( dist[ u ] < dist[ v ] ) || dist[ v ] === Infinity ) continue;
			segs.push( { u, v, flow: flow[ e ] } );
			maxFlow = Math.max( maxFlow, flow[ e ] );
			maxDist = Math.max( maxDist, dist[ v ] );
		}
	}
	return { segs, dist, maxFlow, maxDist, targets };
}

// Chains the drawn edges into branches running from the origin or a junction to the next junction or dead end.
function branches( routes ) {
	const { segs, maxFlow } = routes;
	const children = new Map();
	const isChild = new Set();
	for ( const { u, v, flow } of segs ) {
		if ( ! children.has( u ) ) children.set( u, [] );
		children.get( u ).push( { v, w: Math.pow( flow / maxFlow, .45 ) } );
		isChild.add( v );
	}
	const stack = [];
	for ( const [ u, list ] of children ) if ( ! isChild.has( u ) ) for ( const c of list ) stack.push( [ u, c ] );
	const out = [];
	while ( stack.length ) {
		const [ start, first ] = stack.pop();
		const nodes = [ start, first.v ], weights = [ first.w, first.w ];
		let tail = first.v;
		for ( let next = children.get( tail ); next && next.length === 1; next = children.get( tail ) ) {
			tail = next[ 0 ].v;
			nodes.push( tail );
			weights.push( next[ 0 ].w );
		}
		for ( const c of children.get( tail ) || [] ) stack.push( [ tail, c ] );
		out.push( { nodes, weights } );
	}
	return out;
}

// ---------------------------------------------------------------- rendering

const container = $( 'container' );
const renderer = new THREE.WebGLRenderer( { antialias: true } );
renderer.setPixelRatio( Math.min( devicePixelRatio, 2 ) );
renderer.setSize( innerWidth, innerHeight );
renderer.setClearColor( 0x05060a );
container.appendChild( renderer.domElement );

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera( 50, innerWidth / innerHeight, 1, 50000 );
const controls = new OrbitControls( camera, renderer.domElement );
controls.enableDamping = true;
controls.autoRotate = true;
controls.autoRotateSpeed = .35;
controls.maxPolarAngle = Math.PI * .49;
controls.addEventListener( 'start', () => params.rotate.set( false ) );

const uniforms = {
	uGrow: { value: 0 },
	uPulse: { value: - 1 },
	uExag: { value: 1 },
	uFocus: { value: 1 },
	uAperture: { value: 0 },
	uSize: { value: 1 },
	uCold: { value: new THREE.Vector3( .32, .5, 1 ) },
	uWarm: { value: new THREE.Vector3( 1, .8, .55 ) },
	uResolution: { value: new THREE.Vector2() },
	uPixelRatio: { value: renderer.getPixelRatio() },
};

// Thin-lens defocus shared by both styles. An aperture of diameter A (world units) spreads a point at depth d
// over A·|d − f| / d at the focal plane f; that disc is projected to pixels at the focus distance. The stroke
// and the disc are combined as Gaussians, a disc of diameter c matching one of sigma c/4, so widths add in
// quadrature. Returns sigma in drawing-buffer pixels.
const defocusGLSL = /* glsl */`
	uniform float uFocus, uAperture, uSize, uPixelRatio;
	uniform vec2 uResolution;

	float cocPixels( float depth ) {
		float d = max( depth, 1. );
		return uAperture * abs( d - uFocus ) / d * projectionMatrix[ 1 ][ 1 ] * .5 * uResolution.y / max( uFocus, 1. );
	}

	float defocusSigma( float strokeWidth, float depth ) {
		float core = strokeWidth * uSize * uPixelRatio * .25;
		float coc = cocPixels( depth ) * .25;
		return sqrt( core * core + coc * coc );
	}
`;

// MeshLine-style strips, 3 sigma wide on each side, with Gaussian caps so blurred ends fade instead of stopping.
const lineMaterial = new THREE.ShaderMaterial( {
	uniforms,
	transparent: true,
	depthWrite: false,
	side: THREE.DoubleSide,
	blending: THREE.CustomBlending,
	blendEquation: THREE.MaxEquation,
	vertexShader: /* glsl */`
		uniform float uExag;
		${defocusGLSL}
		attribute vec3 prev, next;
		attribute float side, cap, aDist, aW;
		varying float vSide, vCap, vW, vDist, vEnergy;

		vec2 screen( vec3 p ) {
			vec4 c = projectionMatrix * modelViewMatrix * vec4( p * vec3( 1., uExag, 1. ), 1. );
			return c.xy / c.w * .5 * uResolution;
		}

		void main() {
			vec4 mv = modelViewMatrix * vec4( position * vec3( 1., uExag, 1. ), 1. );
			vec4 c = projectionMatrix * mv;
			vec2 s = c.xy / c.w * .5 * uResolution;
			vec2 d1 = s - screen( prev ), d2 = screen( next ) - s;
			if ( dot( d1, d1 ) < 1e-6 ) d1 = d2;
			if ( dot( d2, d2 ) < 1e-6 ) d2 = d1;
			d1 = dot( d1, d1 ) > 1e-12 ? normalize( d1 ) : vec2( 1., 0. );
			d2 = dot( d2, d2 ) > 1e-12 ? normalize( d2 ) : d1;
			vec2 tangent = d1 + d2;
			tangent = dot( tangent, tangent ) > 1e-6 ? normalize( tangent ) : d1;
			vec2 normal = vec2( - tangent.y, tangent.x );

			float stroke = 1.2 + 12. * aW;
			float core = stroke * uSize * uPixelRatio * .25;
			float sigma = min( defocusSigma( stroke, - mv.z ), 133. );
			float hw = 3. * sigma;
			vec2 offset = normal * side * hw + tangent * cap * hw;
			c.xy += offset / ( .5 * uResolution ) * c.w;
			gl_Position = c;

			// A line spreads only across itself, so its peak falls with sigma, not sigma squared.
			vEnergy = core / sigma;
			vSide = side;
			vCap = cap;
			vW = aW;
			vDist = aDist;
		}
	`,
	fragmentShader: /* glsl */`
		uniform float uGrow, uPulse;
		uniform vec3 uCold, uWarm;
		varying float vSide, vCap, vW, vDist, vEnergy;

		void main() {
			if ( vDist > uGrow ) discard;
			float g = exp( - ( vSide * vSide + vCap * vCap ) * 4.5 ) * vEnergy;
			float tip = exp( - max( uGrow - vDist, 0. ) / 60. );
			float pulse = uPulse > 0. ? exp( - abs( uPulse - vDist ) / 25. ) * ( .3 + vW ) : 0.;
			vec3 cold = uCold;
			vec3 warm = uWarm;
			float t = pow( vW, .5 );
			vec3 col = mix( cold, warm, t ) * ( .35 + .9 * t ) + warm * ( tip + pulse );
			gl_FragColor = vec4( col * g, 1. );
		}
	`,
} );

// Gaussian sprites 3 sigma in radius, dimmed so each keeps the same total light however far it is defocused.
const particleMaterial = new THREE.ShaderMaterial( {
	uniforms,
	transparent: true,
	depthWrite: false,
	blending: THREE.AdditiveBlending,
	vertexShader: /* glsl */`
		uniform float uGrow, uExag;
		${defocusGLSL}
		attribute float aDist, aW;
		varying float vAlpha, vW, vDist;

		void main() {
			vec4 mv = modelViewMatrix * vec4( position * vec3( 1., uExag, 1. ), 1. );
			float stroke = 1.6 + 4. * aW;
			float core = stroke * uSize * uPixelRatio * .25;
			float sigma = min( defocusSigma( stroke, - mv.z ), 85. );
			vAlpha = core * core / ( sigma * sigma );
			vW = aW;
			vDist = aDist;
			bool visible = aDist <= uGrow;
			gl_Position = visible ? projectionMatrix * mv : vec4( 2., 2., 2., 1. );
			gl_PointSize = visible ? 6. * sigma : 0.;
		}
	`,
	fragmentShader: /* glsl */`
		uniform float uGrow, uPulse;
		uniform vec3 uCold, uWarm;
		varying float vAlpha, vW, vDist;

		void main() {
			float q = length( gl_PointCoord - .5 ) * 2.;
			float g = exp( - q * q * 4.5 );
			float tip = exp( - max( uGrow - vDist, 0. ) / 60. );
			float pulse = uPulse > 0. ? exp( - abs( uPulse - vDist ) / 25. ) * ( .3 + vW ) : 0.;
			vec3 cold = uCold;
			vec3 warm = uWarm;
			float t = pow( vW, .5 );
			vec3 col = mix( cold, warm, t ) * ( .3 + .7 * t ) + warm * ( tip + pulse );
			gl_FragColor = vec4( col * g * vAlpha * .7, 1. );
		}
	`,
} );

const markerMaterial = new THREE.ShaderMaterial( {
	uniforms: { ...uniforms, uTime: { value: 0 } },
	transparent: true,
	depthWrite: false,
	blending: THREE.AdditiveBlending,
	vertexShader: /* glsl */`
		uniform float uExag, uPixelRatio;
		void main() {
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position * vec3( 1., uExag, 1. ), 1. );
			gl_PointSize = 48. * uPixelRatio;
		}
	`,
	fragmentShader: /* glsl */`
		uniform float uTime;
		void main() {
			float d = length( gl_PointCoord - .5 ) * 2.;
			float ring = exp( - abs( d - fract( uTime * .5 ) ) * 20. ) * ( 1. - fract( uTime * .5 ) );
			float core = exp( - d * 9. );
			gl_FragColor = vec4( vec3( 1., .85, .6 ) * ( core * 1.5 + ring ), 1. );
		}
	`,
} );

let arteries = null, dust = null, marker = null;
let growStart = 0, maxDist = 1;

function buildMeshes( g, elev, routes, polylines, radius ) {
	const { segs, dist, maxFlow, maxDist: md } = routes;
	const count = segs.length;
	const aStart = new Float32Array( count * 3 ), aEnd = new Float32Array( count * 3 );
	const aD0 = new Float32Array( count ), aD1 = new Float32Array( count ), aW = new Float32Array( count );
	for ( let i = 0; i < count; i ++ ) {
		const { u, v, flow } = segs[ i ];
		aStart.set( [ g.xs[ u ], elev[ u ], g.zs[ u ] ], i * 3 );
		aEnd.set( [ g.xs[ v ], elev[ v ], g.zs[ v ] ], i * 3 );
		aD0[ i ] = dist[ u ];
		aD1[ i ] = dist[ v ];
		aW[ i ] = Math.pow( flow / maxFlow, .45 );
	}

	clearMeshes();
	arteries = new THREE.Mesh( stripGeometry( g, elev, dist, polylines, radius / 150 ), lineMaterial );
	arteries.frustumCulled = false;
	scene.add( arteries );

	dust = new THREE.Points( particleGeometry( aStart, aEnd, aD0, aD1, aW, radius / 320 ), particleMaterial );
	dust.frustumCulled = false;
	scene.add( dust );
	applyStyle();

	const markerGeometry = new THREE.BufferGeometry();
	markerGeometry.setAttribute( 'position', new THREE.Float32BufferAttribute( [ 0, 0, 0 ], 3 ) );
	marker = new THREE.Points( markerGeometry, markerMaterial );
	marker.frustumCulled = false;
	scene.add( marker );

	maxDist = md;
	return count;
}

// Each polyline point is emitted twice (one per side) with its neighbours, plus a cap slot at both ends.
// Long segments are split so the defocus, which only varies per vertex, can narrow where a street crosses focus.
function stripGeometry( g, elev, dist, polylines, step ) {
	const lines = polylines.map( ( { nodes, weights } ) => {
		const pts = [];
		nodes.forEach( ( v, i ) => {
			const p = [ g.xs[ v ], elev[ v ], g.zs[ v ] ];
			if ( i > 0 ) {
				const u = nodes[ i - 1 ], q = [ g.xs[ u ], elev[ u ], g.zs[ u ] ];
				const parts = Math.ceil( Math.hypot( p[ 0 ] - q[ 0 ], p[ 2 ] - q[ 2 ] ) / step );
				for ( let k = 1; k < parts; k ++ ) {
					const t = k / parts;
					pts.push( { p: q.map( ( c, j ) => c + ( p[ j ] - c ) * t ), d: dist[ u ] + ( dist[ v ] - dist[ u ] ) * t, w: weights[ i ] } );
				}
			}
			pts.push( { p, d: dist[ v ], w: weights[ i ] } );
		} );
		return pts;
	} );

	let slots = 0, quads = 0;
	for ( const pts of lines ) { slots += pts.length + 2; quads += pts.length + 1; }
	const position = new Float32Array( slots * 6 ), prev = new Float32Array( slots * 6 ), next = new Float32Array( slots * 6 );
	const side = new Float32Array( slots * 2 ), cap = new Float32Array( slots * 2 );
	const aDist = new Float32Array( slots * 2 ), aW = new Float32Array( slots * 2 );
	const index = new Uint32Array( quads * 6 );
	const put = ( array, slot, p ) => {
		array.set( p, slot * 6 );
		array.set( p, slot * 6 + 3 );
	};
	let slot = 0, q = 0;
	for ( const pts of lines ) {
		const n = pts.length, first = slot;
		for ( let k = - 1; k <= n; k ++, slot ++ ) {
			const i = Math.min( Math.max( k, 0 ), n - 1 );
			put( position, slot, pts[ i ].p );
			put( prev, slot, pts[ k === n ? n - 2 : Math.max( i - 1, 0 ) ].p );
			put( next, slot, pts[ k === - 1 ? 1 : Math.min( i + 1, n - 1 ) ].p );
			const c = k === - 1 ? - 1 : k === n ? 1 : 0;
			side.set( [ - 1, 1 ], slot * 2 );
			cap.set( [ c, c ], slot * 2 );
			aDist.set( [ pts[ i ].d, pts[ i ].d ], slot * 2 );
			aW.set( [ pts[ i ].w, pts[ i ].w ], slot * 2 );
		}
		for ( let k = first; k < slot - 1; k ++, q ++ ) {
			const a = k * 2;
			index.set( [ a, a + 1, a + 2, a + 1, a + 3, a + 2 ], q * 6 );
		}
	}
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( position, 3 ) );
	geometry.setAttribute( 'prev', new THREE.BufferAttribute( prev, 3 ) );
	geometry.setAttribute( 'next', new THREE.BufferAttribute( next, 3 ) );
	geometry.setAttribute( 'side', new THREE.BufferAttribute( side, 1 ) );
	geometry.setAttribute( 'cap', new THREE.BufferAttribute( cap, 1 ) );
	geometry.setAttribute( 'aDist', new THREE.BufferAttribute( aDist, 1 ) );
	geometry.setAttribute( 'aW', new THREE.BufferAttribute( aW, 1 ) );
	geometry.setIndex( new THREE.BufferAttribute( index, 1 ) );
	return geometry;
}

// Scatters particles along each segment at roughly even spacing, jittered so they never line up into dots.
function particleGeometry( aStart, aEnd, aD0, aD1, aW, spacing ) {
	const count = aW.length;
	const per = new Int32Array( count );
	let total = 0;
	for ( let i = 0; i < count; i ++ ) {
		const o = i * 3;
		const l = Math.hypot( aEnd[ o ] - aStart[ o ], aEnd[ o + 1 ] - aStart[ o + 1 ], aEnd[ o + 2 ] - aStart[ o + 2 ] );
		per[ i ] = Math.max( 1, Math.round( l / spacing ) );
		total += per[ i ];
	}
	const position = new Float32Array( total * 3 ), aDist = new Float32Array( total ), w = new Float32Array( total );
	let p = 0;
	for ( let i = 0; i < count; i ++ ) {
		const o = i * 3;
		for ( let j = 0; j < per[ i ]; j ++, p ++ ) {
			const t = ( j + Math.random() ) / per[ i ];
			for ( let c = 0; c < 3; c ++ ) position[ p * 3 + c ] = aStart[ o + c ] + ( aEnd[ o + c ] - aStart[ o + c ] ) * t;
			aDist[ p ] = aD0[ i ] + ( aD1[ i ] - aD0[ i ] ) * t;
			w[ p ] = aW[ i ];
		}
	}
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( position, 3 ) );
	geometry.setAttribute( 'aDist', new THREE.BufferAttribute( aDist, 1 ) );
	geometry.setAttribute( 'aW', new THREE.BufferAttribute( w, 1 ) );
	return geometry;
}

function applyStyle() {
	const particles = params.style.peek() === 'particles';
	if ( arteries ) arteries.visible = ! particles;
	if ( dust ) dust.visible = particles;
}

function clearMeshes() {
	for ( const m of [ arteries, dust, marker ] ) {
		if ( ! m ) continue;
		scene.remove( m );
		m.geometry.dispose();
	}
	arteries = dust = marker = null;
}

function frame( radius ) {
	camera.position.set( 0, radius * .95, radius * 2.1 );
	controls.target.set( 0, 0, 0 );
	controls.update();
}

function replay() {
	growStart = performance.now();
}

function resize() {
	renderer.setSize( innerWidth, innerHeight );
	camera.aspect = innerWidth / innerHeight;
	camera.updateProjectionMatrix();
	renderer.getDrawingBufferSize( uniforms.uResolution.value );
}

const stats = createStats();
const fps = stats.fps();
const frameTime = stats.timer( 'frame' );

function animate() {
	frameTime.start();
	const now = performance.now();
	const grow = params.grow.peek();
	const t = Math.max( now - growStart, 0 ) / 1000;
	const k = Math.min( t / grow, 1 );
	uniforms.uGrow.value = ( 1 - ( 1 - k ) ** 3 ) * ( maxDist + 1 );
	const cycle = 6, after = t - grow - 1;
	uniforms.uPulse.value = params.pulse.peek() && after > 0 && after % cycle < cycle * .7 ? ( after % cycle ) / ( cycle * .7 ) * maxDist : - 1;
	markerMaterial.uniforms.uTime.value = now / 1000;
	controls.update();
	uniforms.uFocus.value = camera.position.distanceTo( controls.target );
	renderer.render( scene, camera );
	frameTime.end();
	fps.tick();
	stats.flush();
}

// ---------------------------------------------------------------- flow

let current = null;
let lastPlace = null;
let loaded = null;

let routing = 0;

async function reroute() {
	if ( ! loaded ) return;
	const token = ++ routing;
	const { g, elev, source, radius, name } = loaded;
	const algorithm = params.algorithm.peek();
	const t0 = performance.now();
	const options = { algorithm, radius, count: params.count.peek(), layout: params.layout.peek(), bundling: params.bundling.peek() };
	const routes = await route( g, source, options, ( r, rounds ) => {
		if ( rounds < 2 ) return;
		progress.set( .95 + .05 * r / rounds );
		setStatus( `Routing ${name}… round ${r} / ${rounds}` );
	}, () => token !== routing );
	if ( ! routes ) return;
	const polylines = branches( routes );
	loaded.routes = routes;
	loaded.polylines = polylines;
	// Framed on most of the drawing, so one long causeway out to the radius doesn't set the zoom.
	const reach = routes.segs.map( ( { v } ) => Math.hypot( g.xs[ v ], g.zs[ v ] ) ).sort( ( x, y ) => x - y );
	loaded.extent = reach[ Math.floor( reach.length * .9 ) ] || 0;
	const count = buildMeshes( g, elev, routes, polylines, radius );
	const ms = Math.round( performance.now() - t0 );
	replay();
	const what = algorithm === 'all' ? 'every street' : `${routes.targets} destinations`;
	setStatus( `${name} · ${what} · ${count.toLocaleString()} street segments routed in ${ms} ms` );
	info.segments.set( count );
	info.destinations.set( routes.targets );
	info.routing.set( ms );
}

async function show( place, keepProgress = false ) {
	current?.abort();
	if ( ! keepProgress ) progress.reset();
	const job = current = new AbortController();
	const signal = job.signal;
	const radius = params.radius.peek();
	const started = performance.now();
	lastPlace = place;
	history.replaceState( null, '', `#${place.lat.toFixed( 5 )},${place.lon.toFixed( 5 )},${radius}` );
	document.querySelectorAll( '#cities a' ).forEach( ( a ) => a.classList.toggle( 'active', a.textContent === place.name ) );

	try {
		const fetchRadius = Math.round( radius * 1.25 );
		const fromOverpass = () => {
			const expected = 3e6 * ( fetchRadius / 1500 ) ** 2;
			let waitingOn = null;
			return fetchStreets( place.lat, place.lon, fetchRadius, signal, ( { host, bytes } ) => {
				if ( bytes === 0 ) {
					if ( waitingOn === host ) return;
					waitingOn = host;
					setStatus( `Asking ${host} for the streets around ${place.name}…` );
					progress.creep( progress.value, .3, 4 );
					return;
				}
				progress.stop();
				progress.set( .3 + .4 * ( 1 - Math.exp( - bytes / expected ) ) );
				setStatus( `Downloading streets around ${place.name}… ${MB( bytes )}` );
			} );
		};
		const fromTiles = () => fetchStreetsFromTiles( place.lat, place.lon, fetchRadius, signal, ( { loaded, total, bytes, stitching } ) => {
			if ( stitching ) {
				progress.set( .66 );
				setStatus( `Joining streets across ${total} map tiles…` );
				return;
			}
			progress.set( .05 + .6 * Math.max( loaded / total, Math.min( bytes / ( total * 1.6e6 ), .95 ) ) );
			setStatus( `Downloading map tiles around ${place.name}… ${loaded} / ${total} (${MB( bytes )})` );
		} );

		let elements;
		if ( params.source.peek() === 'tiles' ) {
			try {
				elements = await fromTiles();
			} catch ( e ) {
				if ( signal.aborted ) throw e;
				console.warn( e );
				elements = await fromOverpass();
			}
		} else {
			elements = await fromOverpass();
		}
		progress.set( .7 );
		setStatus( `Building the street graph (${elements.length.toLocaleString()} elements)…` );
		await nextFrame();
		const g = buildGraph( elements, place.lat, place.lon );
		const source = nearestNode( g, 0, 0, g.connected );
		if ( source < 0 ) throw new Error( 'No walkable streets here' );

		let elev, ground = () => 0;
		try {
			const inArea = ( i ) => Math.hypot( g.xs[ i ], g.zs[ i ] ) <= fetchRadius;
			const terrain = await loadElevation( g.lats, g.lons, radius > 2000 ? 13 : 14, inArea, signal, ( loaded, total ) => {
				progress.set( .72 + .2 * loaded / total );
				setStatus( `Reading terrain… ${loaded} / ${total} tiles` );
			} );
			elev = terrain.heights;
			const base = elev[ source ];
			for ( let i = 0; i < elev.length; i ++ ) elev[ i ] -= base;
			ground = ( x, z ) => terrain.sample( g.lat0 - z / g.kz, g.lon0 + x / g.kx ) - base;
		} catch ( e ) {
			if ( signal.aborted ) throw e;
			elev = new Float32Array( g.n );
		}

		if ( signal.aborted ) return;
		progress.set( .95 );
		setStatus( `Routing ${g.n.toLocaleString()} street nodes…` );
		await nextFrame();
		if ( signal.aborted ) return;

		loaded = { g, elev, ground, source, radius, name: place.name };
		sceneRadius.set( radius );
		info.nodes.set( g.n );
		await reroute();
		if ( signal.aborted ) return;
		frame( Math.max( loaded.extent || radius, radius * .3 ) );
		progress.done();
		info.load.set( Math.round( performance.now() - started ) );
	} catch ( e ) {
		if ( signal.aborted ) return;
		console.error( e );
		progress.fail();
		setStatus( e.message || String( e ), true );
	}
}

async function exportSTL() {
	if ( ! loaded?.polylines ) return;
	const { g, elev, ground, polylines, radius, name } = loaded;
	setStatus( 'Building the printable model…' );
	await nextFrame();
	const size = params.printSize.peek();
	const { blob, triangles } = buildSTL( { g, elev, ground, polylines, radius, exag: params.terrain.target(), size, base: params.printBase.peek() } );
	const a = document.createElement( 'a' );
	a.href = URL.createObjectURL( blob );
	a.download = `urban-arteries-${name.toLowerCase().replace( /[^a-z0-9]+/g, '-' ).replace( /^-|-$/g, '' )}.stl`;
	a.click();
	setTimeout( () => URL.revokeObjectURL( a.href ), 1000 );
	setStatus( `Exported ${a.download} · ${size} mm · ${triangles.toLocaleString()} triangles · ${MB( blob.size )}` );
	info.exported.set( `${triangles.toLocaleString()} triangles, ${MB( blob.size )}` );
}

async function search( query ) {
	try {
		current?.abort();
		progress.reset();
		progress.creep( 0, .08, 1 );
		setStatus( `Looking up “${query}”…` );
		show( await geocode( query ), true );
	} catch ( e ) {
		progress.fail();
		setStatus( e.message, true );
	}
}

const citiesEl = $( 'cities' );
for ( const [ name, lat, lon ] of CITIES ) {
	const li = document.createElement( 'li' );
	const a = document.createElement( 'a' );
	a.textContent = name;
	a.addEventListener( 'click', () => show( { name, lat, lon } ) );
	li.appendChild( a );
	citiesEl.appendChild( li );
}

$( 'search' ).addEventListener( 'submit', ( e ) => {
	e.preventDefault();
	const q = $( 'query' ).value.trim();
	if ( q ) search( q );
} );

$( 'locate' ).addEventListener( 'click', () => {
	setStatus( 'Waiting for your location…' );
	navigator.geolocation.getCurrentPosition(
		( p ) => show( { lat: p.coords.latitude, lon: p.coords.longitude, name: 'You are here' } ),
		( err ) => setStatus( err.message, true ),
	);
} );

// ---------------------------------------------------------------- panel

const rgb = ( hex ) => [ 1, 3, 5 ].map( ( i ) => parseInt( hex.slice( i, i + 2 ), 16 ) / 255 );

effect( () => { uniforms.uAperture.value = params.aperture() / 100 * sceneRadius(); } );
effect( () => { uniforms.uSize.value = params.size(); } );
effect( () => { uniforms.uExag.value = params.terrain(); } );
effect( () => { uniforms.uCold.value.set( ...rgb( params.cold() ) ); } );
effect( () => { uniforms.uWarm.value.set( ...rgb( params.warm() ) ); } );
effect( () => {
	renderer.setClearColor( params.background() );
	document.body.style.background = params.background();
} );
effect( () => { controls.autoRotate = params.rotate(); } );
effect( () => { params.style(); applyStyle(); } );

// Routing reruns on the graph already loaded; a short debounce keeps a slider drag from queueing dozens.
let rerouteTimer = 0;
effect( () => {
	params.algorithm(); params.count(); params.layout(); params.bundling();
	clearTimeout( rerouteTimer );
	rerouteTimer = setTimeout( reroute, 150 );
} );

let started = false;
effect( () => {
	params.radius(); params.source();
	if ( started && lastPlace ) untrack( () => show( lastPlace ) );
	started = true;
} );

const presets = createPresetStore( params, {
	storageKey: 'urban-arteries-presets',
	exclude: [ 'printSize', 'printBase' ],
	builtin: {
		Dendrite: { algorithm: 'main', bundling: 1, count: 300, layout: 'ring', style: 'lines', aperture: 5, size: 1 },
		'Soft focus': { style: 'particles', aperture: 12, size: 1.4 },
		'Sharp lines': { style: 'lines', aperture: 0, size: 1.2 },
		'Every street': { algorithm: 'all', style: 'lines', aperture: 3, size: .6 },
		Scattered: { algorithm: 'shortest', layout: 'scatter', count: 400 },
		Ember: { cold: '#ff5a36', warm: '#ffe08a', background: '#0a0503' },
		Ice: { cold: '#3a6bff', warm: '#c8f0ff', background: '#02040a' },
	},
} );

const RADII = [ 600, 1200, 2000, 3000, 4000, 5000 ].map( ( r ) => [ r, r < 1000 ? `${r} m` : `${r / 1000} km` ] );
const fixed = { randomizable: false };
const gui = new GUI( 'Urban Arteries', $( 'gui-container' ), { storageKey: 'urban-arteries-gui' } );

gui.addTab( 'Routes' );
gui.addSection( 'Data' );
gui.addSegmented( 'Streets', params.source, [ [ 'tiles', 'Map tiles' ], [ 'overpass', 'Overpass' ] ], { ...fixed, title: 'Map tiles are fast and reliable; Overpass has the full OpenStreetMap detail' } );
gui.addSelect( 'Radius', params.radius, RADII, fixed );
gui.addSection( 'Routing' );
gui.addSegmented( 'Algorithm', params.algorithm, [ [ 'main', 'Main' ], [ 'shortest', 'Shortest' ], [ 'all', 'Every' ] ], { ...fixed, title: 'Main streets with bundling, plain shortest paths, or the tree to every street' } );
const routed = () => params.algorithm() !== 'all';
gui.addSlider( 'Destinations', params.count, 10, 1000, 10, { ...fixed, curve: 2, visibleWhen: routed } );
gui.addSegmented( 'Targets', params.layout, [ [ 'ring', 'Ring' ], [ 'scatter', 'Scattered' ] ], { ...fixed, visibleWhen: routed } );
gui.addSlider( 'Bundling', params.bundling, 0, 1, .05, { ...fixed, visibleWhen: () => params.algorithm() === 'main', title: 'How strongly later routes merge onto streets earlier routes used' } );

gui.addTab( 'Look' );
gui.addRandomizeButton( 'Randomize look (R)', () => {} );
gui.addSection( 'Render' );
gui.addSegmented( 'Style', params.style, [ [ 'particles', 'Particles' ], [ 'lines', 'Lines' ] ] );
gui.addSlider( 'Aperture %', params.aperture, 0, 20, .1, { curve: 2, title: 'Lens aperture diameter as a share of the radius; streets soften away from the focal plane at the orbit centre' } );
gui.addSlider( 'Size', params.size, .25, 5, .05, { curve: 2 } ).randomize = () => params.size.set( +( .6 + Math.random() * 1.4 ).toFixed( 2 ) );
gui.addSlider( 'Terrain', params.terrain, 0, 20, .1, { curve: 2 } ).randomize = () => params.terrain.set( +( Math.random() * 8 ).toFixed( 1 ) );
gui.addSection( 'Colour' );
gui.addColor( 'Side streets', params.cold );
gui.addColor( 'Arteries', params.warm );
gui.addColor( 'Background', params.background, fixed );
gui.addSection( 'Motion' );
gui.addSlider( 'Growth', params.grow, .5, 20, .5, { ...fixed, curve: 2, title: 'Seconds for the tree to grow out from the origin' } );
gui.addCheckbox( 'Pulse', params.pulse, fixed );
gui.addCheckbox( 'Auto-rotate', params.rotate, fixed );
gui.addButton( 'Replay (Space)', replay );

gui.addTab( 'Print' );
gui.addText( 'Each branch becomes a tube as thick as its traffic, with spheres at the joints, scaled to the diameter below. Binary STL in millimetres; slicers merge the overlapping shells.' );
gui.addSlider( 'Diameter mm', params.printSize, 60, 300, 10, fixed );
gui.addSegmented( 'Base', params.printBase, [ [ 'relief', 'Terrain' ], [ 'plate', 'Flat' ], [ 'none', 'None' ] ], { ...fixed, title: 'Terrain follows the Terrain exaggeration; Flat lays the routes on a plate' } );
gui.addButton( 'Export STL (E)', exportSTL );
gui.addMonitor( 'Last export', info.exported );

gui.addTab( 'Presets' );
gui.addPresets( presets );

gui.addTab( 'Stats' );
gui.addGraph( 'Frame ms', frameTime, { min: 0, over: 16.7 } );
gui.addMonitor( 'FPS', fps, { format: ( v ) => v.toFixed( 0 ), below: 50 } );
gui.addSeparator();
const thousands = ( v ) => v.toLocaleString();
gui.addMonitor( 'Street nodes', info.nodes, { format: thousands } );
gui.addMonitor( 'Destinations', info.destinations, { format: thousands } );
gui.addMonitor( 'Segments drawn', info.segments, { format: thousands } );
gui.addMonitor( 'Load', info.load, { format: ( v ) => `${( v / 1000 ).toFixed( 1 )} s` } );
gui.addMonitor( 'Routing', info.routing, { format: ( v ) => `${v} ms` } );

bindKey( 'Space', replay );
bindKey( 'KeyE', exportSTL );
bindKey( 'KeyL', () => params.style.set( params.style.peek() === 'lines' ? 'particles' : 'lines' ) );

addEventListener( 'resize', resize );

resize();
renderer.setAnimationLoop( animate );

const hash = location.hash.slice( 1 ).split( ',' ).map( Number );
if ( hash.length >= 2 && hash.every( Number.isFinite ) ) {
	if ( RADII.some( ( [ r ] ) => r === hash[ 2 ] ) ) params.radius.set( hash[ 2 ] );
	show( { lat: hash[ 0 ], lon: hash[ 1 ], name: `${hash[ 0 ]}, ${hash[ 1 ]}` } );
} else {
	const [ name, lat, lon ] = CITIES[ Math.floor( Math.random() * CITIES.length ) ];
	show( { name, lat, lon } );
}
