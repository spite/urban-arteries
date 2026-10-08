import * as THREE from 'three';

// Buffers for the shapes the arteries are drawn with, all built from paths ({ points: [ [ x, y, z ] ], dist: [],
// weight: [] }, see graph/routes.js toPaths) or destinations ({ point, dist }).

// One instance per segment, carrying its neighbours so a shader can join segments at the bisector, and which ends
// are joined (inside a path) rather than free. Segments longer than `step` are split, for anything evaluated per
// vertex that must vary along a long straight.
export function segmentGeometry( paths, { step = Infinity } = {} ) {
	const segs = [];
	for ( const { points, dist, weight } of paths ) {
		const pts = [];
		points.forEach( ( p, i ) => {
			if ( i > 0 ) {
				const q = points[ i - 1 ];
				const parts = Math.ceil( Math.hypot( p[ 0 ] - q[ 0 ], p[ 1 ] - q[ 1 ], p[ 2 ] - q[ 2 ] ) / step );
				for ( let k = 1; k < parts; k ++ ) {
					const t = k / parts;
					pts.push( { p: q.map( ( c, j ) => c + ( p[ j ] - c ) * t ), d: dist[ i - 1 ] + ( dist[ i ] - dist[ i - 1 ] ) * t, w: weight[ i ] } );
				}
			}
			pts.push( { p, d: dist[ i ], w: weight[ i ] } );
		} );
		const n = pts.length;
		for ( let j = 0; j < n - 1; j ++ ) {
			segs.push( {
				a: pts[ j ], b: pts[ j + 1 ],
				prev: pts[ Math.max( j - 1, 0 ) ].p, next: pts[ Math.min( j + 2, n - 1 ) ].p,
				join: [ j > 0 ? 1 : 0, j + 2 < n ? 1 : 0 ],
			} );
		}
	}

	const count = segs.length;
	const aStart = new Float32Array( count * 3 ), aEnd = new Float32Array( count * 3 );
	const aPrev = new Float32Array( count * 3 ), aNext = new Float32Array( count * 3 );
	const aJoin = new Float32Array( count * 2 ), aDist = new Float32Array( count * 2 ), aW = new Float32Array( count );
	segs.forEach( ( { a, b, prev, next, join }, i ) => {
		aStart.set( a.p, i * 3 );
		aEnd.set( b.p, i * 3 );
		aPrev.set( prev, i * 3 );
		aNext.set( next, i * 3 );
		aJoin.set( join, i * 2 );
		aDist.set( [ a.d, b.d ], i * 2 );
		aW[ i ] = b.w;
	} );

	const geometry = new THREE.InstancedBufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( [ 0, - 1, 0, 1, - 1, 0, 1, 1, 0, 0, 1, 0 ], 3 ) );
	geometry.setIndex( [ 0, 1, 2, 0, 2, 3 ] );
	geometry.setAttribute( 'aStart', new THREE.InstancedBufferAttribute( aStart, 3 ) );
	geometry.setAttribute( 'aEnd', new THREE.InstancedBufferAttribute( aEnd, 3 ) );
	geometry.setAttribute( 'aPrev', new THREE.InstancedBufferAttribute( aPrev, 3 ) );
	geometry.setAttribute( 'aNext', new THREE.InstancedBufferAttribute( aNext, 3 ) );
	geometry.setAttribute( 'aJoin', new THREE.InstancedBufferAttribute( aJoin, 2 ) );
	geometry.setAttribute( 'aDist', new THREE.InstancedBufferAttribute( aDist, 2 ) );
	geometry.setAttribute( 'aW', new THREE.InstancedBufferAttribute( aW, 1 ) );
	geometry.instanceCount = count;
	return geometry;
}

// Particles scattered along paths at roughly `spacing` apart, jittered along each segment so they never line up.
export function particleGeometry( paths, { spacing, random = Math.random } ) {
	let total = 0;
	for ( const { points } of paths ) {
		for ( let i = 1; i < points.length; i ++ ) total += segmentCount( points[ i - 1 ], points[ i ], spacing );
	}
	const position = new Float32Array( total * 3 ), aDist = new Float32Array( total ), aW = new Float32Array( total );
	let p = 0;
	for ( const { points, dist, weight } of paths ) {
		for ( let i = 1; i < points.length; i ++ ) {
			const a = points[ i - 1 ], b = points[ i ], n = segmentCount( a, b, spacing );
			for ( let j = 0; j < n; j ++, p ++ ) {
				const t = ( j + random() ) / n;
				for ( let c = 0; c < 3; c ++ ) position[ p * 3 + c ] = a[ c ] + ( b[ c ] - a[ c ] ) * t;
				aDist[ p ] = dist[ i - 1 ] + ( dist[ i ] - dist[ i - 1 ] ) * t;
				aW[ p ] = weight[ i ];
			}
		}
	}
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( position, 3 ) );
	geometry.setAttribute( 'aDist', new THREE.BufferAttribute( aDist, 1 ) );
	geometry.setAttribute( 'aW', new THREE.BufferAttribute( aW, 1 ) );
	return geometry;
}
function segmentCount( a, b, spacing ) {
	return Math.max( 1, Math.round( Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ], b[ 2 ] - a[ 2 ] ) / spacing ) );
}

// A point per destination, with its distance along the routes.
export function destinationGeometry( destinations ) {
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( new Float32Array( destinations.flatMap( ( t ) => t.point ) ), 3 ) );
	geometry.setAttribute( 'aDist', new THREE.BufferAttribute( new Float32Array( destinations.map( ( t ) => t.dist ) ), 1 ) );
	return geometry;
}
