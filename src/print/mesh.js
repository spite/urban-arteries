// Closed, outward-facing mesh primitives for 3D printing, written into a triangle list through tri( a, b, c ),
// plus a binary STL writer. Points are [ x, y, z ] arrays; z is up, as slicers expect.

const sub = ( a, b ) => [ a[ 0 ] - b[ 0 ], a[ 1 ] - b[ 1 ], a[ 2 ] - b[ 2 ] ];
const cross = ( a, b ) => [ a[ 1 ] * b[ 2 ] - a[ 2 ] * b[ 1 ], a[ 2 ] * b[ 0 ] - a[ 0 ] * b[ 2 ], a[ 0 ] * b[ 1 ] - a[ 1 ] * b[ 0 ] ];
const dot = ( a, b ) => a[ 0 ] * b[ 0 ] + a[ 1 ] * b[ 1 ] + a[ 2 ] * b[ 2 ];
const normalize = ( a ) => { const l = Math.hypot( ...a ) || 1; return [ a[ 0 ] / l, a[ 1 ] / l, a[ 2 ] / l ]; };

export { sub };

// Collects triangles; pass its tri to the primitives and hand list to writeSTL.
export function triangles() {
	const list = [];
	return { list, tri: ( a, b, c ) => list.push( a, b, c ) };
}

// Tube along pts with a radius per point, using parallel-transport frames so the cross-section never twists,
// closed at both ends.
export function tube( pts, radii, tri, sides = 10 ) {
	const n = pts.length;
	const tangents = pts.map( ( p, i ) => normalize( sub( pts[ Math.min( i + 1, n - 1 ) ], pts[ Math.max( i - 1, 0 ) ] ) ) );
	let normal = normalize( cross( tangents[ 0 ], Math.abs( tangents[ 0 ][ 2 ] ) < .9 ? [ 0, 0, 1 ] : [ 1, 0, 0 ] ) );
	const rings = pts.map( ( p, i ) => {
		const t = tangents[ i ];
		normal = normalize( sub( normal, t.map( ( c ) => c * dot( normal, t ) ) ) );
		const binormal = cross( t, normal );
		return Array.from( { length: sides }, ( _, j ) => {
			const a = j / sides * Math.PI * 2, c = Math.cos( a ) * radii[ i ], d = Math.sin( a ) * radii[ i ];
			return [ p[ 0 ] + normal[ 0 ] * c + binormal[ 0 ] * d, p[ 1 ] + normal[ 1 ] * c + binormal[ 1 ] * d, p[ 2 ] + normal[ 2 ] * c + binormal[ 2 ] * d ];
		} );
	} );
	for ( let i = 0; i < n - 1; i ++ ) {
		for ( let j = 0; j < sides; j ++ ) {
			const k = ( j + 1 ) % sides;
			tri( rings[ i ][ j ], rings[ i ][ k ], rings[ i + 1 ][ j ] );
			tri( rings[ i ][ k ], rings[ i + 1 ][ k ], rings[ i + 1 ][ j ] );
		}
	}
	for ( let j = 0; j < sides; j ++ ) {
		const k = ( j + 1 ) % sides;
		tri( pts[ 0 ], rings[ 0 ][ k ], rings[ 0 ][ j ] );
		tri( pts[ n - 1 ], rings[ n - 1 ][ j ], rings[ n - 1 ][ k ] );
	}
}

export function sphere( c, r, tri, { lat = 6, lon = 10 } = {} ) {
	const at = ( i, j ) => {
		const th = i / lat * Math.PI, ph = j / lon * Math.PI * 2;
		return [ c[ 0 ] + r * Math.sin( th ) * Math.cos( ph ), c[ 1 ] + r * Math.sin( th ) * Math.sin( ph ), c[ 2 ] + r * Math.cos( th ) ];
	};
	for ( let i = 0; i < lat; i ++ ) {
		for ( let j = 0; j < lon; j ++ ) {
			const a = at( i, j ), b = at( i, j + 1 ), d = at( i + 1, j ), e = at( i + 1, j + 1 );
			if ( i > 0 ) tri( a, d, b );
			if ( i < lat - 1 ) tri( b, d, e );
		}
	}
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

// Binary STL from a flat list of triangle corners. Resolves nothing asynchronously; returns { blob, triangles }.
export function writeSTL( list ) {
	const count = list.length / 3;
	const view = new DataView( new ArrayBuffer( 84 + count * 50 ) );
	view.setUint32( 80, count, true );
	let o = 84;
	for ( let t = 0; t < list.length; t += 3 ) {
		const a = list[ t ], b = list[ t + 1 ], c = list[ t + 2 ];
		for ( const v of [ normalize( cross( sub( b, a ), sub( c, a ) ) ), a, b, c ] ) {
			for ( const x of v ) { view.setFloat32( o, x, true ); o += 4; }
		}
		o += 2;
	}
	return { blob: new Blob( [ view.buffer ], { type: 'model/stl' } ), triangles: count };
}
