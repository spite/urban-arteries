// Single-source shortest paths over a graph from graph.js, with weights given per edge (Infinity skips an edge).
// turnPenalty (metres) is added when a path bends, which keeps routes through a grid of equal-length streets
// from zigzagging; it is a node-label approximation, not an exact turn-aware search. With goals, the search
// stops once every goal node is settled.

export function shortestPathTree( g, source, weight, { turnPenalty = 0, goals = null } = {} ) {
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
