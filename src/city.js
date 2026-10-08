import { fetchStreetsFromTiles } from './streets/tiles.js';
import { fetchStreetsFromOverpass } from './streets/overpass.js';
import { loadTerrain } from './terrain.js';
import { buildGraph, nearestNode, toLatLon } from './graph/graph.js';

// Everything needed to route around a place: the walkable street graph centred on it, the origin node, and terrain
// heights relative to the origin. Streets come from map tiles, falling back to Overpass, or from Overpass alone;
// terrain falls back to flat when it can't be loaded (in Node it never can).
//
// Streets are fetched out to radius × margin, so routes near the edge can leave the circle and come back.
// onProgress receives { fraction, text, waiting }: waiting is true while a server is working with nothing to show.
// pause() runs between the heavy steps; in a page, pass one that waits for a frame so progress can repaint.
// Resolves to { g, origin, heights, ground( x, z ) }.
export async function loadCity( { lat, lon, name = `${lat.toFixed( 4 )}, ${lon.toFixed( 4 )}` }, {
	radius,
	source = 'tiles',
	margin = 1.25,
	signal,
	onProgress = () => {},
	pause = () => new Promise( ( r ) => setTimeout( r ) ),
} ) {
	const MB = ( bytes ) => ( bytes / 1048576 ).toFixed( 1 ) + ' MB';
	const fetchRadius = Math.round( radius * margin );

	const fromTiles = () => fetchStreetsFromTiles( lat, lon, fetchRadius, { signal, onProgress: ( { loaded, total, bytes, stitching } ) => {
		if ( stitching ) return onProgress( { fraction: .66, text: `Joining streets across ${total} map tiles…` } );
		const fraction = .05 + .6 * Math.max( loaded / total, Math.min( bytes / ( total * 1.6e6 ), .95 ) );
		onProgress( { fraction, text: `Downloading map tiles around ${name}… ${loaded} / ${total} (${MB( bytes )})` } );
	} } );
	const fromOverpass = () => {
		const expected = 3e6 * ( fetchRadius / 1500 ) ** 2;
		return fetchStreetsFromOverpass( lat, lon, fetchRadius, { signal, onProgress: ( { host, bytes } ) => {
			if ( bytes === 0 ) return onProgress( { fraction: .3, text: `Asking ${host} for the streets around ${name}…`, waiting: true } );
			onProgress( { fraction: .3 + .4 * ( 1 - Math.exp( - bytes / expected ) ), text: `Downloading streets around ${name}… ${MB( bytes )}` } );
		} } );
	};

	let elements;
	if ( source === 'tiles' ) {
		try {
			elements = await fromTiles();
		} catch ( e ) {
			if ( signal?.aborted ) throw e;
			elements = await fromOverpass();
		}
	} else {
		elements = await fromOverpass();
	}

	onProgress( { fraction: .7, text: `Building the street graph (${elements.length.toLocaleString()} elements)…` } );
	await pause();
	const g = buildGraph( elements, lat, lon );
	const origin = nearestNode( g, 0, 0, g.connected );
	if ( origin < 0 ) throw new Error( 'No walkable streets here' );

	let heights, ground = () => 0;
	try {
		const terrain = await loadTerrain( g.lats, g.lons, {
			zoom: radius > 2000 ? 13 : 14,
			include: ( i ) => Math.hypot( g.xs[ i ], g.zs[ i ] ) <= fetchRadius,
			signal,
			onProgress: ( loaded, total ) => onProgress( { fraction: .72 + .2 * loaded / total, text: `Reading terrain… ${loaded} / ${total} tiles` } ),
		} );
		heights = terrain.heights;
		const base = heights[ origin ];
		for ( let i = 0; i < heights.length; i ++ ) heights[ i ] -= base;
		ground = ( x, z ) => terrain.sample( ...toLatLon( g, x, z ) ) - base;
	} catch ( e ) {
		if ( signal?.aborted ) throw e;
		heights = new Float32Array( g.n );
	}
	return { g, origin, heights, ground };
}
