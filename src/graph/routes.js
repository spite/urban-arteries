// Routes from one source to many destinations over a graph from graph.js, reduced to the drawn network:
// every used edge, oriented away from the source, with how many routes run along it.

import { shortestPathTree } from './dijkstra.js';

export function seededRandom( seed ) {
	return () => {
		seed = ( seed + 0x6D2B79F5 ) | 0;
		let t = Math.imul( seed ^ ( seed >>> 15 ), 1 | seed );
		t = ( t + Math.imul( t ^ ( t >>> 7 ), 61 | t ) ) ^ t;
		return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;
	};
}

// Ring: the farthest reachable node in each of `count` sectors, which is the radius or wherever the network
// ends first, like a coastline. Scattered: random reachable nodes inside the radius.
export function pickTargets( g, reachable, radius, count, layout ) {
	const random = seededRandom( count * 7919 + ( layout === 'ring' ? 1 : 2 ) );
	if ( layout === 'ring' ) {
		const best = new Int32Array( count ).fill( - 1 ), far = new Float64Array( count );
		const turn = random() * 2 * Math.PI;
		for ( let i = 0; i < g.n; i ++ ) {
			if ( ! reachable[ i ] ) continue;
			const d = Math.hypot( g.xs[ i ], g.zs[ i ] );
			if ( d > radius ) continue;
			const a = ( Math.atan2( g.zs[ i ], g.xs[ i ] ) + turn + 4 * Math.PI ) % ( 2 * Math.PI );
			const k = Math.min( count - 1, Math.floor( a / ( 2 * Math.PI ) * count ) );
			if ( d > far[ k ] ) { far[ k ] = d; best[ k ] = i; }
		}
		return [ ...new Set( best.filter( ( i ) => i >= 0 ) ) ];
	}
	const inside = [];
	for ( let i = 0; i < g.n; i ++ ) if ( reachable[ i ] && Math.hypot( g.xs[ i ], g.zs[ i ] ) <= radius ) inside.push( i );
	const targets = new Set();
	for ( let j = 0; j < count * 4 && targets.size < Math.min( count, inside.length ); j ++ ) targets.add( inside[ Math.floor( random() * inside.length ) ] );
	return [ ...targets ];
}

// algorithm: 'main' prefers main streets (edge cost multipliers), avoids needless turns and bundles routes;
// 'shortest' uses plain distance; 'all' is the shortest-path tree to every node within the radius.
// Bundling routes destinations in rounds and makes streets used by earlier rounds cheaper, so later routes
// merge onto them. Yields between rounds; returns null when cancelled() turns true.
// Resolves to { segs: [ { u, v, flow } ], dist, maxFlow, maxDist, targets }, dist being path length along the result.
export async function route( g, source, {
	algorithm = 'main',
	radius,
	count = 800,
	layout = 'ring',
	bundling = .6,
	rounds: maxRounds = 32,
	turnPenalty = 20,
} = {}, { onRound = () => {}, cancelled = () => false } = {} ) {
	const flow = new Float32Array( g.m );

	if ( algorithm === 'all' ) {
		const tree = shortestPathTree( g, source, g.len );
		const through = new Float32Array( g.n );
		for ( let i = tree.order.length - 1; i > 0; i -- ) {
			const v = tree.order[ i ];
			if ( Math.hypot( g.xs[ v ], g.zs[ v ] ) <= radius ) through[ v ] += 1;
			through[ tree.parent[ v ] ] += through[ v ];
			flow[ tree.parentEdge[ v ] ] = through[ v ];
		}
		return collect( g, source, flow, 0 );
	}

	const preferred = algorithm === 'main';
	const base = preferred ? g.len.map( ( l, e ) => l * g.cost[ e ] ) : g.len;
	const first = shortestPathTree( g, source, base );
	const reachable = first.dist.map( ( d ) => d < Infinity ? 1 : 0 );
	const targets = pickTargets( g, reachable, radius, count, layout );

	const rounds = preferred && bundling > 0 ? Math.min( maxRounds, targets.length ) : 1;
	const weight = new Float32Array( base );
	const random = seededRandom( targets.length );
	for ( let i = targets.length - 1; i > 0; i -- ) {
		const j = Math.floor( random() * ( i + 1 ) );
		[ targets[ i ], targets[ j ] ] = [ targets[ j ], targets[ i ] ];
	}
	const turn = preferred ? turnPenalty : 0;
	for ( let r = 0; r < rounds; r ++ ) {
		const from = Math.floor( r * targets.length / rounds ), to = Math.floor( ( r + 1 ) * targets.length / rounds );
		const tree = r === 0 && ! turn ? first : shortestPathTree( g, source, weight, { turnPenalty: turn, goals: targets.slice( from, to ) } );
		for ( let i = from; i < to; i ++ ) {
			for ( let v = targets[ i ]; v !== source && tree.parent[ v ] >= 0; v = tree.parent[ v ] ) flow[ tree.parentEdge[ v ] ] ++;
		}
		for ( let e = 0; e < g.m; e ++ ) {
			if ( flow[ e ] ) weight[ e ] = base[ e ] * ( 1 - bundling * .95 * ( 1 - Math.exp( - flow[ e ] / .5 ) ) );
		}
		onRound( r + 1, rounds );
		await new Promise( ( resolve ) => setTimeout( resolve ) );
		if ( cancelled() ) return null;
	}
	return collect( g, source, flow, targets.length );
}

function collect( g, source, flow, targets ) {
	const only = flow.map( ( f, e ) => f > 0 ? g.len[ e ] : Infinity );
	const { dist } = shortestPathTree( g, source, only );
	const segs = [];
	let maxFlow = 1, maxDist = 0;
	for ( let u = 0; u < g.n; u ++ ) {
		for ( let h = g.offset[ u ]; h < g.offset[ u + 1 ]; h ++ ) {
			const v = g.adj[ h ], e = g.edge[ h ];
			if ( ! ( flow[ e ] > 0 ) || ! ( dist[ u ] < dist[ v ] ) || dist[ v ] === Infinity ) continue;
			segs.push( { u, v, flow: flow[ e ] } );
			maxFlow = Math.max( maxFlow, flow[ e ] );
			maxDist = Math.max( maxDist, dist[ v ] );
		}
	}
	return { segs, dist, maxFlow, maxDist, targets };
}

// Chains the drawn edges into branches running from the source or a junction to the next junction or dead end.
// Each node gets a weight in 0..1 from the flow arriving at it: ( flow / maxFlow ) ^ exponent.
export function branches( routes, { exponent = .45 } = {} ) {
	const { segs, maxFlow } = routes;
	const children = new Map();
	const isChild = new Set();
	for ( const { u, v, flow } of segs ) {
		if ( ! children.has( u ) ) children.set( u, [] );
		children.get( u ).push( { v, w: Math.pow( flow / maxFlow, exponent ) } );
		isChild.add( v );
	}
	const stack = [];
	for ( const [ u, list ] of children ) if ( ! isChild.has( u ) ) for ( const c of list ) stack.push( [ u, c ] );
	const out = [];
	while ( stack.length ) {
		const [ start, first ] = stack.pop();
		const nodes = [ start, first.v ], weights = [ first.w, first.w ];
		let tail = first.v;
		for ( let next = children.get( tail ); next && next.length === 1; next = children.get( tail ) ) {
			tail = next[ 0 ].v;
			nodes.push( tail );
			weights.push( next[ 0 ].w );
		}
		for ( const c of children.get( tail ) || [] ) stack.push( [ tail, c ] );
		out.push( { nodes, weights } );
	}
	return out;
}

// Branches as plain 3D paths, the format the renderers and the print model take:
// { points: [ [ x, height, z ], … ], dist: [ … ], weight: [ … ] }, one entry per point.
export function toPaths( g, heights, dist, polylines ) {
	return polylines.map( ( { nodes, weights } ) => ( {
		points: nodes.map( ( v ) => [ g.xs[ v ], heights[ v ], g.zs[ v ] ] ),
		dist: nodes.map( ( v ) => dist[ v ] ),
		weight: weights,
	} ) );
}
