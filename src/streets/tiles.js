import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';

// Street network from OpenFreeMap vector tiles (OpenMapTiles schema), returned as OSM-shaped elements:
// { type: 'node', id, lat, lon } and { type: 'way', nodes: [ids], tags: { highway } }, the same shape Overpass returns.
// Tiles are simplified for drawing, so the network is re-noded here: streets are split where they cross,
// dead ends within SNAP of another street are welded onto it, and streets cut at tile edges are joined back.

const TILEJSON = 'https://tiles.openfreemap.org/planet';
const Z = 14;
const EXTENT = 4096;
const SNAP = 2;
const CELL = 32;

// OpenMapTiles transportation class/subclass to the OSM highway values the router weighs.
function highwayOf( { class: cls, subclass, brunnel } ) {
	if ( brunnel === 'tunnel' ) return null;
	switch ( cls ) {
		case 'trunk': case 'primary': case 'secondary': case 'tertiary': case 'service': case 'track': return cls;
		case 'minor': return 'residential';
		case 'pier': return 'footway';
		case 'path': return /^(cycleway|corridor|platform)$/.test( subclass ) ? null : subclass || 'path';
		default: return null;
	}
}

let template = null;

async function tileTemplate( signal ) {
	if ( ! template ) {
		const res = await fetch( TILEJSON, { signal } );
		if ( ! res.ok ) throw new Error( `tiles.openfreemap.org: ${res.status}` );
		template = ( await res.json() ).tiles[ 0 ];
	}
	return template;
}

// Retries a few times, since one dropped tile would otherwise fail the whole area.
async function loadTile( url, signal, onBytes ) {
	for ( let attempt = 1; ; attempt ++ ) {
		try {
			return await readTile( url, signal, onBytes );
		} catch ( e ) {
			if ( signal?.aborted || attempt === 3 ) throw e;
			await new Promise( ( r ) => setTimeout( r, 500 * attempt ) );
		}
	}
}

async function readTile( url, signal, onBytes ) {
	const res = await fetch( url, { signal } );
	if ( ! res.ok ) throw new Error( `tiles.openfreemap.org: ${res.status}` );
	const chunks = [];
	for ( const reader = res.body.getReader(); ; ) {
		const { done, value } = await reader.read();
		if ( done ) break;
		chunks.push( value );
		onBytes( value.length );
	}
	return new VectorTile( new Pbf( new Uint8Array( await new Blob( chunks ).arrayBuffer() ) ) );
}

// Liang–Barsky: the part of segment a→b inside [0, EXTENT]², or null.
function clip( ax, ay, bx, by ) {
	let t0 = 0, t1 = 1;
	const dx = bx - ax, dy = by - ay;
	for ( const [ p, q ] of [ [ - dx, ax ], [ dx, EXTENT - ax ], [ - dy, ay ], [ dy, EXTENT - ay ] ] ) {
		if ( p === 0 ) { if ( q < 0 ) return null; continue; }
		const r = q / p;
		if ( p < 0 ) { if ( r > t1 ) return null; if ( r > t0 ) t0 = r; } else { if ( r < t0 ) return null; if ( r < t1 ) t1 = r; }
	}
	if ( t1 - t0 < 1e-9 ) return null;
	return [ ax + dx * t0, ay + dy * t0, ax + dx * t1, ay + dy * t1 ];
}

// onProgress receives { loaded, total, bytes } while tiles download, then { stitching: true } before the re-noding.
export async function fetchStreetsFromTiles( lat, lon, radius, { signal, onProgress = () => {} } = {} ) {
	const url = await tileTemplate( signal );
	const n = 2 ** Z;
	const tileX = ( lo ) => ( lo + 180 ) / 360 * n;
	const tileY = ( la ) => ( 1 - Math.log( Math.tan( la * Math.PI / 180 ) + 1 / Math.cos( la * Math.PI / 180 ) ) / Math.PI ) / 2 * n;
	const dLat = radius / 110540, dLon = radius / ( 111320 * Math.cos( lat * Math.PI / 180 ) );
	const tx0 = Math.floor( tileX( lon - dLon ) ), tx1 = Math.floor( tileX( lon + dLon ) );
	const ty0 = Math.floor( tileY( lat + dLat ) ), ty1 = Math.floor( tileY( lat - dLat ) );

	const coords = [];
	for ( let ty = ty0; ty <= ty1; ty ++ ) for ( let tx = tx0; tx <= tx1; tx ++ ) coords.push( [ tx, ty ] );
	let loaded = 0, bytes = 0;
	onProgress( { loaded, total: coords.length, bytes } );
	const queue = coords.slice();
	const tiles = [];
	const worker = async () => {
		while ( queue.length ) {
			const [ tx, ty ] = queue.shift();
			const tile = await loadTile( url.replace( '{z}', Z ).replace( '{x}', tx ).replace( '{y}', ty ), signal, ( b ) => {
				bytes += b;
				onProgress( { loaded, total: coords.length, bytes } );
			} );
			tiles.push( { tx, ty, tile } );
			onProgress( { loaded: ++ loaded, total: coords.length, bytes } );
		}
	};
	await Promise.all( Array.from( { length: 8 }, worker ) );
	// Download order varies; a fixed order keeps node numbering, and so routing ties, the same every load.
	tiles.sort( ( a, b ) => a.ty - b.ty || a.tx - b.tx );
	onProgress( { loaded, total: coords.length, bytes, stitching: true } );
	// Lets a page repaint before the re-noding; outside a browser a plain timeout does.
	await new Promise( ( r ) => typeof requestAnimationFrame === 'function' ? requestAnimationFrame( () => setTimeout( r ) ) : setTimeout( r ) );

	// Segments in a shared grid: integer units of the z14 tile extent, relative to the first tile.
	const ax = [], ay = [], bx = [], by = [], kind = [], bridge = [];
	for ( const { tx, ty, tile } of tiles ) {
		const layer = tile.layers.transportation;
		if ( ! layer ) continue;
		const ox = ( tx - tx0 ) * EXTENT, oy = ( ty - ty0 ) * EXTENT;
		for ( let i = 0; i < layer.length; i ++ ) {
			const f = layer.feature( i );
			if ( f.type !== 2 ) continue;
			const highway = highwayOf( f.properties );
			if ( ! highway ) continue;
			const isBridge = f.properties.brunnel === 'bridge';
			for ( const line of f.loadGeometry() ) {
				for ( let j = 1; j < line.length; j ++ ) {
					const c = clip( line[ j - 1 ].x, line[ j - 1 ].y, line[ j ].x, line[ j ].y );
					if ( ! c ) continue;
					ax.push( Math.round( c[ 0 ] + ox ) ); ay.push( Math.round( c[ 1 ] + oy ) );
					bx.push( Math.round( c[ 2 ] + ox ) ); by.push( Math.round( c[ 3 ] + oy ) );
					kind.push( highway ); bridge.push( isBridge );
				}
			}
		}
	}

	const key = ( x, y ) => x * 1048576 + y;
	const segCount = ax.length;
	const seen = new Set();
	const grid = new Map();
	const cellsOf = ( i, pad ) => {
		const out = [];
		const x0 = Math.floor( ( Math.min( ax[ i ], bx[ i ] ) - pad ) / CELL ), x1 = Math.floor( ( Math.max( ax[ i ], bx[ i ] ) + pad ) / CELL );
		const y0 = Math.floor( ( Math.min( ay[ i ], by[ i ] ) - pad ) / CELL ), y1 = Math.floor( ( Math.max( ay[ i ], by[ i ] ) + pad ) / CELL );
		for ( let x = x0; x <= x1; x ++ ) for ( let y = y0; y <= y1; y ++ ) out.push( x * 65536 + y );
		return out;
	};
	const live = [];
	for ( let i = 0; i < segCount; i ++ ) {
		if ( ax[ i ] === bx[ i ] && ay[ i ] === by[ i ] ) continue;
		// Neighbouring tiles repeat the same segment in their buffers.
		const k1 = key( ax[ i ], ay[ i ] ), k2 = key( bx[ i ], by[ i ] );
		const k = k1 < k2 ? k1 + ':' + k2 : k2 + ':' + k1;
		if ( seen.has( k ) ) continue;
		seen.add( k );
		live.push( i );
		for ( const c of cellsOf( i, SNAP ) ) {
			let list = grid.get( c );
			if ( ! list ) grid.set( c, list = [] );
			list.push( i );
		}
	}

	const splits = new Map();
	const addSplit = ( i, t, x, y ) => {
		let list = splits.get( i );
		if ( ! list ) splits.set( i, list = [] );
		list.push( [ t, x, y ] );
	};

	// Simplified tiles drop the shared vertex where streets cross; split both streets at the crossing instead.
	const tested = new Set();
	for ( const list of grid.values() ) {
		for ( let p = 0; p < list.length; p ++ ) for ( let q = p + 1; q < list.length; q ++ ) {
			const i = list[ p ], j = list[ q ];
			if ( bridge[ i ] || bridge[ j ] ) continue;
			const pair = i < j ? i * segCount + j : j * segCount + i;
			if ( tested.has( pair ) ) continue;
			tested.add( pair );
			const rx = bx[ i ] - ax[ i ], ry = by[ i ] - ay[ i ], sx = bx[ j ] - ax[ j ], sy = by[ j ] - ay[ j ];
			const den = rx * sy - ry * sx;
			if ( den === 0 ) continue;
			const qx = ax[ j ] - ax[ i ], qy = ay[ j ] - ay[ i ];
			const t = ( qx * sy - qy * sx ) / den, u = ( qx * ry - qy * rx ) / den;
			if ( t <= 1e-6 || t >= 1 - 1e-6 || u <= 1e-6 || u >= 1 - 1e-6 ) continue;
			const x = Math.round( ax[ i ] + rx * t ), y = Math.round( ay[ i ] + ry * t );
			addSplit( i, t, x, y );
			addSplit( j, u, x, y );
		}
	}

	// Dead ends that stop within SNAP of another street are T-junctions or tile seams: weld them on.
	const degree = new Map();
	for ( const i of live ) for ( const k of [ key( ax[ i ], ay[ i ] ), key( bx[ i ], by[ i ] ) ] ) degree.set( k, ( degree.get( k ) || 0 ) + 1 );
	const alias = new Map();
	for ( const i of live ) {
		for ( const end of [ 0, 1 ] ) {
			const px = end ? bx[ i ] : ax[ i ], py = end ? by[ i ] : ay[ i ];
			if ( degree.get( key( px, py ) ) !== 1 ) continue;
			const cell = Math.floor( px / CELL ) * 65536 + Math.floor( py / CELL );
			let best = null, bestD = SNAP;
			for ( const j of grid.get( cell ) || [] ) {
				if ( j === i ) continue;
				for ( const [ vx, vy ] of [ [ ax[ j ], ay[ j ] ], [ bx[ j ], by[ j ] ] ] ) {
					const d = Math.hypot( vx - px, vy - py );
					if ( d > 0 && d <= bestD ) { bestD = d; best = { vx, vy }; }
				}
				const dx = bx[ j ] - ax[ j ], dy = by[ j ] - ay[ j ];
				const t = ( ( px - ax[ j ] ) * dx + ( py - ay[ j ] ) * dy ) / ( dx * dx + dy * dy );
				if ( t <= 0 || t >= 1 ) continue;
				const d = Math.hypot( ax[ j ] + dx * t - px, ay[ j ] + dy * t - py );
				if ( d < bestD ) { bestD = d; best = { j, t }; }
			}
			if ( ! best ) continue;
			if ( best.j === undefined ) {
				alias.set( key( px, py ), key( best.vx, best.vy ) );
			} else {
				const j = best.j, t = best.t;
				const x = Math.round( ax[ j ] + ( bx[ j ] - ax[ j ] ) * t ), y = Math.round( ay[ j ] + ( by[ j ] - ay[ j ] ) * t );
				addSplit( j, t, x, y );
				if ( x !== px || y !== py ) alias.set( key( px, py ), key( x, y ) );
			}
		}
	}

	// Emit Overpass-shaped elements so the same graph builder handles both sources.
	const resolve = ( k ) => { for ( let n = 0; alias.has( k ) && n < 8; n ++ ) k = alias.get( k ); return k; };
	const nodes = new Map();
	const nodeId = ( x, y ) => {
		const k = resolve( key( x, y ) );
		if ( ! nodes.has( k ) ) nodes.set( k, { type: 'node', id: nodes.size, k } );
		return nodes.get( k ).id;
	};
	const ways = [];
	for ( const i of live ) {
		const pts = [ [ 0, ax[ i ], ay[ i ] ], ...( splits.get( i ) || [] ).sort( ( a, b ) => a[ 0 ] - b[ 0 ] ), [ 1, bx[ i ], by[ i ] ] ];
		const ids = pts.map( ( [ , x, y ] ) => nodeId( x, y ) ).filter( ( id, p, all ) => p === 0 || id !== all[ p - 1 ] );
		if ( ids.length > 1 ) ways.push( { type: 'way', nodes: ids, tags: { highway: kind[ i ] } } );
	}

	const scale = n * EXTENT;
	const elements = [];
	for ( const node of nodes.values() ) {
		const gx = Math.floor( node.k / 1048576 ) + tx0 * EXTENT, gy = node.k % 1048576 + ty0 * EXTENT;
		node.lon = gx / scale * 360 - 180;
		node.lat = Math.atan( Math.sinh( Math.PI * ( 1 - 2 * gy / scale ) ) ) * 180 / Math.PI;
		delete node.k;
		elements.push( node );
	}
	return elements.concat( ways );
}
