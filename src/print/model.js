// Printable model of a set of paths ({ points: [ [ x, height, z ] ], weight: [ 0..1 ] } in metres, y up):
// a capped tube per path along a smooth curve through its points, sized by weight, a sphere at every path end, on
// an optional base, as binary STL in millimetres. Overlapping shells are left for the slicer to merge.

import * as THREE from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { TubeGeometry } from './tube-geometry.js';
import { triangles, disc } from './mesh.js';

// size: model diameter in mm, covering radius × 1.04 of the scene. exag: vertical exaggeration.
// base: 'relief' (a disc following ground( x, z ) in metres), 'plate' (everything flattened onto a plate) or 'none'.
// step: tube length per ring in mm; sides: segments around a tube.
export function buildPrintModel( paths, { radius, size = 150, exag = 1, base = 'relief', ground = () => 0, minRadius = .45, embed = .4, step = .5, sides = 10 } = {} ) {
	const extent = radius * 1.04;
	const s = size / ( 2 * extent );
	const flat = base === 'plate';
	const zOf = ( h ) => flat ? 0 : h * exag * s;
	const rMax = Math.max( size * .012, minRadius * 2 );
	const radiusOf = ( w ) => minRadius + ( rMax - minRadius ) * w;
	const lift = ( r ) => base === 'none' ? r : r * ( 1 - 2 * embed );

	// Print space is x east, y north, z up; the scene's z points south.
	const toPrint = ( p, r ) => new THREE.Vector3( p[ 0 ] * s, - p[ 2 ] * s, zOf( p[ 1 ] ) + lift( r ) );

	const model = new THREE.Group();
	const add = ( geometry ) => model.add( new THREE.Mesh( geometry ) );
	const joints = new Map();
	for ( const path of paths ) {
		const pts = [], radii = [], along = [ 0 ];
		path.points.forEach( ( p, i ) => {
			const r = radiusOf( path.weight[ i ] );
			const q = toPrint( p, r );
			if ( pts.length && q.distanceTo( pts[ pts.length - 1 ] ) < 1e-4 ) return;
			if ( pts.length ) along.push( along[ along.length - 1 ] + q.distanceTo( pts[ pts.length - 1 ] ) );
			pts.push( q );
			radii.push( r );
		} );
		if ( pts.length < 2 ) continue;

		// Centripetal, so the curve never overshoots or loops at a sharp street corner.
		const curve = new THREE.CatmullRomCurve3( pts, false, 'centripetal' );
		const length = along[ along.length - 1 ];
		let k = 0;
		const radiusAt = ( t ) => {
			const d = t * length;
			while ( k > 0 && along[ k ] > d ) k --;
			while ( k < along.length - 2 && along[ k + 1 ] < d ) k ++;
			const f = Math.min( Math.max( ( d - along[ k ] ) / ( along[ k + 1 ] - along[ k ] ), 0 ), 1 );
			return radii[ k ] + ( radii[ k + 1 ] - radii[ k ] ) * f;
		};
		add( new TubeGeometry( curve, Math.max( 2, Math.ceil( curve.getLength() / step ) ), 1, sides, false, radiusAt, true ) );

		const ends = [ [ 0, path.points[ 0 ] ], [ pts.length - 1, path.points[ path.points.length - 1 ] ] ];
		for ( const [ i, p ] of ends ) {
			const key = p[ 0 ] + ',' + p[ 2 ], r = radii[ i ];
			if ( ! joints.has( key ) || joints.get( key ).r < r ) joints.set( key, { p: pts[ i ], r } );
		}
	}
	for ( const { p, r } of joints.values() ) add( new THREE.SphereGeometry( r, sides, Math.ceil( sides * .6 ) ).rotateX( Math.PI / 2 ).translate( p.x, p.y, p.z ) );

	if ( base !== 'none' ) {
		const { list, tri } = triangles();
		const top = flat ? () => 0 : ( x, y ) => ground( x / s, - y / s ) * exag * s;
		disc( size / 2, top, tri );
		add( new THREE.BufferGeometry().setAttribute( 'position', new THREE.Float32BufferAttribute( list.flat(), 3 ) ) );
	}

	const stl = new STLExporter().parse( model, { binary: true } );
	for ( const mesh of model.children ) mesh.geometry.dispose();
	return { blob: new Blob( [ stl.buffer ], { type: 'model/stl' } ), triangles: stl.getUint32( 80, true ) };
}
