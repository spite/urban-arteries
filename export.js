// Printable model of the drawn routes: a closed tube per branch sized by traffic, a sphere at every joint,
// on an optional base, written as binary STL in millimetres. Overlapping shells are left for the slicer to merge.

const SIDES = 10;
const RINGS = 64;
const SECTORS = 256;
const BASE_THICKNESS = 2;
const MIN_RADIUS = .45;
const EMBED = .4;

const sub = ( a, b ) => [ a[ 0 ] - b[ 0 ], a[ 1 ] - b[ 1 ], a[ 2 ] - b[ 2 ] ];
const cross = ( a, b ) => [ a[ 1 ] * b[ 2 ] - a[ 2 ] * b[ 1 ], a[ 2 ] * b[ 0 ] - a[ 0 ] * b[ 2 ], a[ 0 ] * b[ 1 ] - a[ 1 ] * b[ 0 ] ];
const dot = ( a, b ) => a[ 0 ] * b[ 0 ] + a[ 1 ] * b[ 1 ] + a[ 2 ] * b[ 2 ];
const normalize = ( a ) => { const l = Math.hypot( ...a ) || 1; return [ a[ 0 ] / l, a[ 1 ] / l, a[ 2 ] / l ]; };

// size: model diameter in mm. exag: vertical exaggeration. base: 'relief' | 'plate' | 'none'.
export function buildSTL( { g, elev, ground, polylines, radius, exag, size, base } ) {
	const extent = radius * 1.04;
	const s = size / ( 2 * extent );
	const flat = base === 'plate';
	const zOf = ( h ) => flat ? 0 : h * exag * s;
	const rMax = Math.max( size * .012, MIN_RADIUS * 2 );
	const radiusOf = ( w ) => MIN_RADIUS + ( rMax - MIN_RADIUS ) * w;
	const lift = ( r ) => base === 'none' ? r : r * ( 1 - 2 * EMBED );

	const tris = [];
	const tri = ( a, b, c ) => tris.push( a, b, c );

	// Ground plane is x east, y north, z up; the scene's z points south.
	const point = ( v, r ) => [ g.xs[ v ] * s, - g.zs[ v ] * s, zOf( elev[ v ] ) + lift( r ) ];

	const joints = new Map();
	for ( const { nodes, weights } of polylines ) {
		const pts = [], radii = [];
		nodes.forEach( ( v, i ) => {
			const r = radiusOf( weights[ i ] );
			const p = point( v, r );
			if ( pts.length && Math.hypot( ...sub( p, pts[ pts.length - 1 ] ) ) < 1e-4 ) return;
			pts.push( p );
			radii.push( r );
		} );
		if ( pts.length < 2 ) continue;
		tube( pts, radii, tri );
		for ( const [ i, v ] of [ [ 0, nodes[ 0 ] ], [ pts.length - 1, nodes[ nodes.length - 1 ] ] ] ) {
			const r = radii[ i ];
			if ( ! joints.has( v ) || joints.get( v ).r < r ) joints.set( v, { p: point( v, r ), r } );
		}
	}
	for ( const { p, r } of joints.values() ) sphere( p, r, tri );

	if ( base !== 'none' ) {
		const top = flat ? () => 0 : ( x, y ) => ground( x / s, - y / s ) * exag * s;
		disc( size / 2, top, tri );
	}
	return writeSTL( tris );
}

// Tube with parallel-transport frames so the cross-section never twists, closed at both ends.
function tube( pts, radii, tri ) {
	const n = pts.length;
	const tangents = pts.map( ( p, i ) => normalize( sub( pts[ Math.min( i + 1, n - 1 ) ], pts[ Math.max( i - 1, 0 ) ] ) ) );
	let normal = normalize( cross( tangents[ 0 ], Math.abs( tangents[ 0 ][ 2 ] ) < .9 ? [ 0, 0, 1 ] : [ 1, 0, 0 ] ) );
	const rings = pts.map( ( p, i ) => {
		const t = tangents[ i ];
		normal = normalize( sub( normal, t.map( ( c ) => c * dot( normal, t ) ) ) );
		const binormal = cross( t, normal );
		return Array.from( { length: SIDES }, ( _, j ) => {
			const a = j / SIDES * Math.PI * 2, c = Math.cos( a ) * radii[ i ], d = Math.sin( a ) * radii[ i ];
			return [ p[ 0 ] + normal[ 0 ] * c + binormal[ 0 ] * d, p[ 1 ] + normal[ 1 ] * c + binormal[ 1 ] * d, p[ 2 ] + normal[ 2 ] * c + binormal[ 2 ] * d ];
		} );
	} );
	for ( let i = 0; i < n - 1; i ++ ) {
		for ( let j = 0; j < SIDES; j ++ ) {
			const k = ( j + 1 ) % SIDES;
			tri( rings[ i ][ j ], rings[ i ][ k ], rings[ i + 1 ][ j ] );
			tri( rings[ i ][ k ], rings[ i + 1 ][ k ], rings[ i + 1 ][ j ] );
		}
	}
	for ( let j = 0; j < SIDES; j ++ ) {
		const k = ( j + 1 ) % SIDES;
		tri( pts[ 0 ], rings[ 0 ][ k ], rings[ 0 ][ j ] );
		tri( pts[ n - 1 ], rings[ n - 1 ][ j ], rings[ n - 1 ][ k ] );
	}
}

function sphere( c, r, tri ) {
	const lat = 6, lon = SIDES;
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

// Closed disc: a polar-grid top following top(x, y), a vertical rim and a flat bottom.
function disc( R, top, tri ) {
	const ring = ( k ) => Array.from( { length: SECTORS }, ( _, j ) => {
		const a = j / SECTORS * Math.PI * 2, r = R * k / RINGS;
		const x = Math.cos( a ) * r, y = Math.sin( a ) * r;
		return [ x, y, top( x, y ) ];
	} );
	const centre = [ 0, 0, top( 0, 0 ) ];
	const rings = Array.from( { length: RINGS }, ( _, k ) => ring( k + 1 ) );
	let lowest = centre[ 2 ];
	for ( const r of rings ) for ( const p of r ) lowest = Math.min( lowest, p[ 2 ] );
	const floor = lowest - BASE_THICKNESS;

	for ( let j = 0; j < SECTORS; j ++ ) {
		const k = ( j + 1 ) % SECTORS;
		tri( centre, rings[ 0 ][ j ], rings[ 0 ][ k ] );
		for ( let i = 0; i < RINGS - 1; i ++ ) {
			tri( rings[ i ][ j ], rings[ i + 1 ][ j ], rings[ i ][ k ] );
			tri( rings[ i ][ k ], rings[ i + 1 ][ j ], rings[ i + 1 ][ k ] );
		}
		const t0 = rings[ RINGS - 1 ][ j ], t1 = rings[ RINGS - 1 ][ k ];
		const b0 = [ t0[ 0 ], t0[ 1 ], floor ], b1 = [ t1[ 0 ], t1[ 1 ], floor ];
		tri( t0, b0, t1 );
		tri( t1, b0, b1 );
		tri( [ 0, 0, floor ], b1, b0 );
	}
}

function writeSTL( tris ) {
	const count = tris.length / 3;
	const view = new DataView( new ArrayBuffer( 84 + count * 50 ) );
	view.setUint32( 80, count, true );
	let o = 84;
	for ( let t = 0; t < tris.length; t += 3 ) {
		const a = tris[ t ], b = tris[ t + 1 ], c = tris[ t + 2 ];
		for ( const v of [ normalize( cross( sub( b, a ), sub( c, a ) ) ), a, b, c ] ) {
			for ( const x of v ) { view.setFloat32( o, x, true ); o += 4; }
		}
		o += 2;
	}
	return { blob: new Blob( [ view.buffer ], { type: 'model/stl' } ), triangles: count };
}
