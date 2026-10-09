// Closed, outward-facing mesh primitives for 3D printing, written into a triangle list through tri( a, b, c ).
// Points are [ x, y, z ] arrays; z is up, as slicers expect.

// Collects triangles; pass its tri to the primitives.
export function triangles() {
	const list = [];
	return { list, tri: ( a, b, c ) => list.push( a, b, c ) };
}

// Closed disc of radius R: a polar-grid top at height top( x, y ), a vertical rim, and a flat bottom
// `thickness` below the lowest point of the top.
export function disc( R, top, tri, { rings: ringCount = 64, sectors = 256, thickness = 2 } = {} ) {
	const ring = ( k ) => Array.from( { length: sectors }, ( _, j ) => {
		const a = j / sectors * Math.PI * 2, r = R * k / ringCount;
		const x = Math.cos( a ) * r, y = Math.sin( a ) * r;
		return [ x, y, top( x, y ) ];
	} );
	const centre = [ 0, 0, top( 0, 0 ) ];
	const rings = Array.from( { length: ringCount }, ( _, k ) => ring( k + 1 ) );
	let lowest = centre[ 2 ];
	for ( const r of rings ) for ( const p of r ) lowest = Math.min( lowest, p[ 2 ] );
	const floor = lowest - thickness;

	for ( let j = 0; j < sectors; j ++ ) {
		const k = ( j + 1 ) % sectors;
		tri( centre, rings[ 0 ][ j ], rings[ 0 ][ k ] );
		for ( let i = 0; i < ringCount - 1; i ++ ) {
			tri( rings[ i ][ j ], rings[ i + 1 ][ j ], rings[ i ][ k ] );
			tri( rings[ i ][ k ], rings[ i + 1 ][ j ], rings[ i + 1 ][ k ] );
		}
		const t0 = rings[ ringCount - 1 ][ j ], t1 = rings[ ringCount - 1 ][ k ];
		const b0 = [ t0[ 0 ], t0[ 1 ], floor ], b1 = [ t1[ 0 ], t1[ 1 ], floor ];
		tri( t0, b0, t1 );
		tri( t1, b0, b1 );
		tri( [ 0, 0, floor ], b1, b0 );
	}
}
