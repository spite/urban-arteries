import { effect, untrack, signal, bindKey, createStats } from 'guspira';
import { fetchStreetsFromTiles } from './src/streets/tiles.js';
import { fetchStreetsFromOverpass } from './src/streets/overpass.js';
import { loadTerrain } from './src/terrain.js';
import { geocode } from './src/geocode.js';
import { buildGraph, nearestNode, toLatLon } from './src/graph/graph.js';
import { route, branches, toPaths, toTargets } from './src/graph/routes.js';
import { createViewer } from './src/render/viewer.js';
import { createArteries } from './src/render/arteries.js';
import { createAdaptiveScale } from './src/render/adaptive.js';
import { buildPrintModel } from './src/print/model.js';
import { createProgress } from './src/ui/progress.js';
import { buildPanel } from './src/ui/panel.js';
import { createSettings, CITIES, RADII } from './src/params.js';

const $ = ( id ) => document.getElementById( id );
const statusEl = $( 'status' );

const { params, presets } = createSettings();
const sceneRadius = signal( 1200 );
const info = { scale: signal( 1 ), nodes: signal( 0 ), segments: signal( 0 ), destinations: signal( 0 ), load: signal( 0 ), routing: signal( 0 ), exported: signal( '—' ) };

const progress = createProgress( $( 'progress' ) );

function setStatus( text, error = false ) {
	statusEl.textContent = text;
	statusEl.classList.toggle( 'error', error );
}

const MB = ( bytes ) => ( bytes / 1048576 ).toFixed( 1 ) + ' MB';

// The address bar carries the whole state, so it can be shared: settings that differ from the defaults in the
// query, the place in the hash as lat,lon,name.
function writeUrl() {
	const query = params.$toQuery();
	const hash = lastPlace ? `#${lastPlace.lat.toFixed( 5 )},${lastPlace.lon.toFixed( 5 )},${encodeURIComponent( lastPlace.name )}` : location.hash;
	history.replaceState( null, '', location.pathname + ( query ? '?' + query : '' ) + hash );
}

// Older links put the radius third; a third part that is a radius is read as one rather than as a name.
function readPlace( hash ) {
	const [ lat, lon, ...rest ] = hash.replace( /^#/, '' ).split( ',' );
	if ( ! Number.isFinite( + lat ) || ! Number.isFinite( + lon ) || lat === '' || lon === '' ) return null;
	if ( rest.length === 1 && RADII.includes( + rest[ 0 ] ) ) {
		params.radius.set( + rest[ 0 ] );
		rest.length = 0;
	}
	const name = rest.length ? decodeURIComponent( rest.join( ',' ) ) : `${( + lat ).toFixed( 4 )}, ${( + lon ).toFixed( 4 )}`;
	return { lat: + lat, lon: + lon, name };
}
const nextFrame = () => new Promise( ( r ) => requestAnimationFrame( () => setTimeout( r ) ) );

// ---------------------------------------------------------------- view

const viewer = createViewer( $( 'container' ) );
const arteries = createArteries( viewer.uniforms );
viewer.scene.add( arteries.group );
viewer.controls.addEventListener( 'start', () => params.rotate.set( false ) );

const stats = createStats();
const fps = stats.fps();
const frameTime = stats.timer( 'frame' );
const adaptive = createAdaptiveScale( ( scale ) => {
	viewer.setScale( scale );
	info.scale.set( scale );
} );
let lastFrame = 0;

function animate() {
	const now = performance.now();
	if ( lastFrame ) adaptive.frame( now - lastFrame );
	lastFrame = now;
	frameTime.start();
	arteries.update( performance.now(), { grow: params.grow.peek(), pulse: params.pulse.peek() } );
	viewer.render();
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
	const options = { algorithm, radius, count: params.count.peek(), layout: params.layout.peek(), depth: params.depth.peek(), bundling: params.bundling.peek() };
	const routes = await route( g, source, options, {
		onRound: ( r, rounds ) => {
			if ( rounds < 2 ) return;
			progress.set( .95 + .05 * r / rounds );
			setStatus( `Routing ${name}… round ${r} / ${rounds}` );
		},
		cancelled: () => token !== routing,
	} );
	if ( ! routes ) return;
	loaded.paths = toPaths( g, elev, routes.dist, branches( routes ) );
	// Framed on most of the drawing, so one long causeway out to the radius doesn't set the zoom.
	const reach = routes.segs.map( ( { v } ) => Math.hypot( g.xs[ v ], g.zs[ v ] ) ).sort( ( x, y ) => x - y );
	loaded.extent = reach[ Math.floor( reach.length * .9 ) ] || 0;
	arteries.set( loaded.paths, { radius, maxDist: routes.maxDist, targets: toTargets( g, elev, routes ) } );
	arteries.replay();
	const ms = Math.round( performance.now() - t0 );
	const count = routes.segs.length;
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
	writeUrl();
	document.querySelectorAll( '#cities a' ).forEach( ( a ) => a.classList.toggle( 'active', a.textContent === place.name ) );

	try {
		const fetchRadius = Math.round( radius * 1.25 );
		const fromOverpass = () => {
			const expected = 3e6 * ( fetchRadius / 1500 ) ** 2;
			let waitingOn = null;
			return fetchStreetsFromOverpass( place.lat, place.lon, fetchRadius, { signal, onProgress: ( { host, bytes } ) => {
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
			} } );
		};
		const fromTiles = () => fetchStreetsFromTiles( place.lat, place.lon, fetchRadius, { signal, onProgress: ( { loaded, total, bytes, stitching } ) => {
			if ( stitching ) {
				progress.set( .66 );
				setStatus( `Joining streets across ${total} map tiles…` );
				return;
			}
			progress.set( .05 + .6 * Math.max( loaded / total, Math.min( bytes / ( total * 1.6e6 ), .95 ) ) );
			setStatus( `Downloading map tiles around ${place.name}… ${loaded} / ${total} (${MB( bytes )})` );
		} } );

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
			const terrain = await loadTerrain( g.lats, g.lons, {
				zoom: radius > 2000 ? 13 : 14,
				include: ( i ) => Math.hypot( g.xs[ i ], g.zs[ i ] ) <= fetchRadius,
				signal,
				onProgress: ( loaded, total ) => {
					progress.set( .72 + .2 * loaded / total );
					setStatus( `Reading terrain… ${loaded} / ${total} tiles` );
				},
			} );
			elev = terrain.heights;
			const base = elev[ source ];
			for ( let i = 0; i < elev.length; i ++ ) elev[ i ] -= base;
			ground = ( x, z ) => terrain.sample( ...toLatLon( g, x, z ) ) - base;
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
		viewer.frame( Math.max( loaded.extent || radius, radius * .3 ), { tilt: params.tilt.peek() } );
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
	if ( ! loaded?.paths ) return;
	const { paths, ground, radius, name } = loaded;
	setStatus( 'Building the printable model…' );
	await nextFrame();
	const size = params.printSize.peek();
	const { blob, triangles } = buildPrintModel( paths, { radius, size, exag: params.terrain.target(), base: params.printBase.peek(), ground } );
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

// ---------------------------------------------------------------- page

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

// ---------------------------------------------------------------- settings

// Picked colours are sRGB; the shaders work in linear light, which the tone-mapping pass converts back.
const rgb = ( hex ) => [ 1, 3, 5 ].map( ( i ) => {
	const c = parseInt( hex.slice( i, i + 2 ), 16 ) / 255;
	return c <= .04045 ? c / 12.92 : ( ( c + .055 ) / 1.055 ) ** 2.4;
} );
const fovOf = ( mm ) => 2 * Math.atan( 12 / mm ) * 180 / Math.PI;
const { uniforms } = viewer;

effect( () => { uniforms.uAperture.value = params.aperture() / 100 * sceneRadius(); } );
effect( () => { uniforms.uSize.value = params.size(); } );
effect( () => { uniforms.uChroma.value = params.chroma(); } );
effect( () => { uniforms.uRim.value = params.rim(); } );
effect( () => { viewer.setLook( { exposure: params.exposure(), bloom: params.bloom(), grain: params.grain() } ); } );
effect( () => { viewer.setFov( fovOf( params.lens() ) ); } );
effect( () => { viewer.setTilt( params.tilt() ); } );
effect( () => { uniforms.uExag.value = params.terrain(); } );
effect( () => { uniforms.uCold.value.set( ...rgb( params.cold() ) ); } );
effect( () => { uniforms.uWarm.value.set( ...rgb( params.warm() ) ); } );
effect( () => {
	viewer.setBackground( params.background() );
	document.body.style.background = params.background();
} );
effect( () => { viewer.controls.autoRotate = params.rotate(); } );
effect( () => { viewer.setPipeline( params.pipeline() ); } );
effect( () => { adaptive.setCeiling( params.resolution() ); } );
effect( () => { adaptive.setEnabled( params.adaptive() ); } );
effect( () => { arteries.setStyle( params.style() ); } );
effect( () => { arteries.setTargetsVisible( params.targets() ); } );

// Routing reruns on the graph already loaded; a short debounce keeps a slider drag from queueing dozens.
let rerouteTimer = 0;
effect( () => {
	params.algorithm(); params.count(); params.layout(); params.depth(); params.bundling();
	clearTimeout( rerouteTimer );
	rerouteTimer = setTimeout( reroute, 150 );
} );

let started = false;
effect( () => {
	params.radius(); params.source();
	if ( started && lastPlace ) untrack( () => show( lastPlace ) );
	started = true;
} );

buildPanel( $( 'gui-container' ), { params, presets, info, stats: { fps, frameTime }, actions: { replay: arteries.replay, exportSTL } } );

bindKey( 'Space', arteries.replay );
bindKey( 'KeyE', exportSTL );
bindKey( 'KeyL', () => params.style.set( params.style.peek() === 'lines' ? 'particles' : 'lines' ) );
bindKey( 'KeyT', () => params.targets.set( ! params.targets.peek() ) );

viewer.renderer.setAnimationLoop( animate );

// Every setting change rewrites the URL; one debounced write covers a whole slider drag.
let urlTimer = 0;
effect( () => {
	for ( const key of params.$keys ) params[ key ].target();
	clearTimeout( urlTimer );
	urlTimer = setTimeout( writeUrl, 250 );
} );

const linked = readPlace( location.hash );
if ( linked ) {
	show( linked );
} else {
	const [ name, lat, lon ] = CITIES[ Math.floor( Math.random() * CITIES.length ) ];
	show( { name, lat, lon } );
}
