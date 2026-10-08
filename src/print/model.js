// Printable model of a set of paths ({ points: [ [ x, height, z ] ], weight: [ 0..1 ] } in metres, y up):
// a closed tube per path sized by weight, a sphere at every path end, on an optional base, as binary STL in
// millimetres. Overlapping shells are left for the slicer to merge.

import { triangles, tube, sphere, disc, writeSTL, sub } from './mesh.js';

// size: model diameter in mm, covering radius × 1.04 of the scene. exag: vertical exaggeration.
// base: 'relief' (a disc following ground( x, z ) in metres), 'plate' (everything flattened onto a plate) or 'none'.
export function buildPrintModel( paths, { radius, size = 150, exag = 1, base = 'relief', ground = () => 0, minRadius = .45, embed = .4 } = {} ) {
	const extent = radius * 1.04;
	const s = size / ( 2 * extent );
	const flat = base === 'plate';
	const zOf = ( h ) => flat ? 0 : h * exag * s;
	const rMax = Math.max( size * .012, minRadius * 2 );
	const radiusOf = ( w ) => minRadius + ( rMax - minRadius ) * w;
	const lift = ( r ) => base === 'none' ? r : r * ( 1 - 2 * embed );
	const { list, tri } = triangles();

	// Print space is x east, y north, z up; the scene's z points south.
	const toPrint = ( p, r ) => [ p[ 0 ] * s, - p[ 2 ] * s, zOf( p[ 1 ] ) + lift( r ) ];

	const joints = new Map();
	for ( const path of paths ) {
		const pts = [], radii = [];
		path.points.forEach( ( p, i ) => {
			const r = radiusOf( path.weight[ i ] );
			const q = toPrint( p, r );
			if ( pts.length && Math.hypot( ...sub( q, pts[ pts.length - 1 ] ) ) < 1e-4 ) return;
			pts.push( q );
			radii.push( r );
		} );
		if ( pts.length < 2 ) continue;
		tube( pts, radii, tri );
		const ends = [ [ 0, path.points[ 0 ] ], [ pts.length - 1, path.points[ path.points.length - 1 ] ] ];
		for ( const [ i, p ] of ends ) {
			const key = p[ 0 ] + ',' + p[ 2 ], r = radii[ i ];
			if ( ! joints.has( key ) || joints.get( key ).r < r ) joints.set( key, { p: toPrint( p, r ), r } );
		}
	}
	for ( const { p, r } of joints.values() ) sphere( p, r, tri );

	if ( base !== 'none' ) {
		const top = flat ? () => 0 : ( x, y ) => ground( x / s, - y / s ) * exag * s;
		disc( size / 2, top, tri );
	}
	return writeSTL( list );
}
