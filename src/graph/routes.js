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

// Ring: destinations near the outer edge of the network, one per sector of the circle. The edge is the farthest
// reachable node per half degree, widened over ±2° so a gap between two radial streets doesn't pull it inward,
// yet it still follows a coastline. A node qualifies within depth × radius of that edge (at least 2%); `count` of
// them are taken evenly through the qualifiers in angular order. Scattered: random reachable nodes inside the radius.
export function pickDestinations( g, reachable, radius, count, layout, { depth = .1 } = {} ) {
	const random = seededRandom( count * 7919 + ( layout === 'ring' ? 1 : 2 ) );
	if ( layout === 'ring' ) {
		const BINS = 720, SPREAD = 4, TAU = 2 * Math.PI;
		const turn = random() * TAU;
		const angle = ( i ) => ( Math.atan2( g.zs[ i ], g.xs[ i ] ) + turn + 2 * TAU ) % TAU;
		const far = new Float64Array( BINS );
		for ( let i = 0; i < g.n; i ++ ) {
			if ( ! reachable[ i ] ) continue;
			const d = Math.hypot( g.xs[ i ], g.zs[ i ] );
			if ( d > radius ) continue;
			const b = Math.min( BINS - 1, Math.floor( angle( i ) / TAU * BINS ) );
			far[ b ] = Math.max( far[ b ], d );
		}
		const edge = Float64Array.from( far, ( _, b ) => {
			let m = 0;
			for ( let k = - SPREAD; k <= SPREAD; k ++ ) m = Math.max( m, far[ ( b + k + BINS ) % BINS ] );
			return m;
		} );
		const band = Math.max( depth, .02 ) * radius;
		const near = [];
		for ( let i = 0; i < g.n; i ++ ) {
			if ( ! reachable[ i ] ) continue;
			const d = Math.hypot( g.xs[ i ], g.zs[ i ] );
			if ( d > radius ) continue;
			const a = angle( i );
			if ( d >= edge[ Math.min( BINS - 1, Math.floor( a / TAU * BINS ) ) ] - band ) near.push( [ a, i ] );
		}
		near.sort( ( x, y ) => x[ 0 ] - y[ 0 ] );
		if ( near.length <= count ) return near.map( ( [ , i ] ) => i );
		return Array.from( { length: count }, ( _, k ) => near[ Math.floor( ( k + random() ) * near.length / count ) ][ 1 ] );
	}
	const inside = [];
	for ( let i = 0; i < g.n; i ++ ) if ( reachable[ i ] && Math.hypot( g.xs[ i ], g.zs[ i ] ) <= radius ) inside.push( i );
	const destinations = new Set();
	for ( let j = 0; j < count * 4 && destinations.size < Math.min( count, inside.length ); j ++ ) destinations.add( inside[ Math.floor( random() * inside.length ) ] );
	return [ ...destinations ];
}

// algorithm: 'main' prefers main streets (edge cost multipliers), avoids needless turns and bundles routes;
// depth: for a ring, how far in from the network's edge destinations may lie, as a share of the radius;
// 'shortest' uses plain distance; 'all' is the shortest-path tree to every node within the radius.
// Bundling routes destinations in rounds and makes streets used by earlier rounds cheaper, so later routes
// merge onto them. Yields between rounds; returns null when cancelled() turns true.
// Resolves to { segs: [ { u, v, flow } ], dist, maxFlow, maxDist, destinations }: dist is path length along the
// result and destinations the destination nodes.
export async function route( g, source, {
	algorithm = 'main',
	radius,
	count = 800,
	layout = 'ring',
	bundling = .6,
	depth = .1,
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
		return collect( g, source, flow, [] );
	}

	const preferred = algorithm === 'main';
	const base = preferred ? g.len.map( ( l, e ) => l * g.cost[ e ] ) : g.len;
	const first = shortestPathTree( g, source, base );
	const reachable = first.dist.map( ( d ) => d < Infinity ? 1 : 0 );
	const destinations = pickDestinations( g, reachable, radius, count, layout, { depth } );

	const rounds = preferred && bundling > 0 ? Math.min( maxRounds, destinations.length ) : 1;
	const weight = new Float32Array( base );
	const random = seededRandom( destinations.length );
	for ( let i = destinations.length - 1; i > 0; i -- ) {
		const j = Math.floor( random() * ( i + 1 ) );
		[ destinations[ i ], destinations[ j ] ] = [ destinations[ j ], destinations[ i ] ];
	}
	const turn = preferred ? turnPenalty : 0;
	for ( let r = 0; r < rounds; r ++ ) {
		const from = Math.floor( r * destinations.length / rounds ), to = Math.floor( ( r + 1 ) * destinations.length / rounds );
		const tree = r === 0 && ! turn ? first : shortestPathTree( g, source, weight, { turnPenalty: turn, goals: destinations.slice( from, to ) } );
		for ( let i = from; i < to; i ++ ) {
			for ( let v = destinations[ i ]; v !== source && tree.parent[ v ] >= 0; v = tree.parent[ v ] ) flow[ tree.parentEdge[ v ] ] ++;
		}
		for ( let e = 0; e < g.m; e ++ ) {
			if ( flow[ e ] ) weight[ e ] = base[ e ] * ( 1 - bundling * .95 * ( 1 - Math.exp( - flow[ e ] / .5 ) ) );
		}
		onRound( r + 1, rounds );
		await new Promise( ( resolve ) => setTimeout( resolve ) );
		if ( cancelled() ) return null;
	}
	return collect( g, source, flow, destinations );
}

function collect( g, source, flow, destinations ) {
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
	return { segs, dist, maxFlow, maxDist, destinations };
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
	// Routes from different rounds can meet a node from two sides, so the network is not always a tree: each node's
	// children are followed once, by whichever branch reaches it first.
	const expanded = new Set();
	const stack = [];
	for ( const [ u, list ] of children ) {
		if ( isChild.has( u ) ) continue;
		expanded.add( u );
		for ( const c of list ) stack.push( [ u, c ] );
	}
	const out = [];
	while ( stack.length ) {
		const [ start, first ] = stack.pop();
		const nodes = [ start, first.v ], weights = [ first.w, first.w ];
		let tail = first.v;
		for ( let next = children.get( tail ); next && next.length === 1 && ! expanded.has( tail ); next = children.get( tail ) ) {
			expanded.add( tail );
			tail = next[ 0 ].v;
			nodes.push( tail );
			weights.push( next[ 0 ].w );
		}
		if ( ! expanded.has( tail ) ) {
			expanded.add( tail );
			for ( const c of children.get( tail ) || [] ) stack.push( [ tail, c ] );
		}
		out.push( { nodes, weights } );
	}
	return out;
}

// Destinations as { point: [ x, height, z ], dist } for anything drawn at them; unreached ones are dropped.
export function toDestinations( g, heights, routes ) {
	return routes.destinations
		.filter( ( v ) => routes.dist[ v ] < Infinity )
		.map( ( v ) => ( { point: [ g.xs[ v ], heights[ v ], g.zs[ v ] ], dist: routes.dist[ v ] } ) );
}

// How far from the source most of the drawn network reaches: the given quantile of segment-end distances, so one
// long causeway out to the radius doesn't decide the framing.
export function routeExtent( g, routes, quantile = .9 ) {
	const reach = routes.segs.map( ( { v } ) => Math.hypot( g.xs[ v ], g.zs[ v ] ) ).sort( ( a, b ) => a - b );
	return reach[ Math.floor( reach.length * quantile ) ] || 0;
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
