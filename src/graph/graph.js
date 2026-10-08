// Routing graph from OSM-shaped elements ({ type: 'node', id, lat, lon } and { type: 'way', nodes, tags }).
// Nodes are projected to metres around ( lat0, lon0 ): x east, z south, so x/z match a y-up 3D scene.
// Edges are undirected and stored as compressed adjacency; each carries a length and a cost multiplier.

const DEG = Math.PI / 180;

// Walking cost multipliers per highway class: lower means a route prefers it, like a main street.
export const HIGHWAY_COST = {
	pedestrian: .8, primary: .85, secondary: .85, tertiary: .9, trunk: .95,
	primary_link: .9, secondary_link: .9, tertiary_link: .95, trunk_link: 1,
	living_street: 1, unclassified: 1.05, residential: 1.1, footway: 1.15,
	cycleway: 1.2, path: 1.25, steps: 1.3, track: 1.4, bridleway: 1.4, service: 1.5,
};

// Indoor corridors and cycle lanes not open to walkers are left out of a walking network.
export function walkable( tags = {} ) {
	if ( tags.highway === 'corridor' ) return false;
	if ( tags.highway === 'cycleway' && ! /^(yes|designated|permissive)$/.test( tags.foot ) ) return false;
	return true;
}

// `connected` marks nodes on any network at least minComponent the size of the largest, so a start point can
// avoid an isolated footpath without an island city being traded for a bigger mainland network.
export function buildGraph( elements, lat0, lon0, {
	costs = HIGHWAY_COST,
	defaultCost = 1.2,
	include = walkable,
	minComponent = .15,
} = {} ) {
	const kx = 111320 * Math.cos( lat0 * DEG ), kz = 110540;
	const index = new Map();
	const lats = [], lons = [], xs = [], zs = [];
	for ( const el of elements ) {
		if ( el.type !== 'node' ) continue;
		index.set( el.id, lats.length );
		lats.push( el.lat ); lons.push( el.lon );
		xs.push( ( el.lon - lon0 ) * kx );
		zs.push( - ( el.lat - lat0 ) * kz );
	}
	const n = lats.length;
	const ea = [], eb = [], ec = [];
	for ( const el of elements ) {
		if ( el.type !== 'way' || ! include( el.tags ) ) continue;
		const cost = costs[ el.tags?.highway ] ?? defaultCost;
		for ( let i = 1; i < el.nodes.length; i ++ ) {
			const a = index.get( el.nodes[ i - 1 ] ), b = index.get( el.nodes[ i ] );
			if ( a === undefined || b === undefined || a === b ) continue;
			ea.push( a ); eb.push( b ); ec.push( cost );
		}
	}

	const m = ea.length;
	const offset = new Int32Array( n + 1 );
	for ( let i = 0; i < m; i ++ ) { offset[ ea[ i ] + 1 ] ++; offset[ eb[ i ] + 1 ] ++; }
	for ( let i = 0; i < n; i ++ ) offset[ i + 1 ] += offset[ i ];
	const fill = offset.slice( 0, n );
	const adj = new Int32Array( m * 2 ), edge = new Int32Array( m * 2 );
	const len = new Float32Array( m ), cost = new Float32Array( ec );
	for ( let i = 0; i < m; i ++ ) {
		const a = ea[ i ], b = eb[ i ];
		len[ i ] = Math.hypot( xs[ a ] - xs[ b ], zs[ a ] - zs[ b ] );
		adj[ fill[ a ] ] = b; edge[ fill[ a ] ++ ] = i;
		adj[ fill[ b ] ] = a; edge[ fill[ b ] ++ ] = i;
	}

	const root = Int32Array.from( { length: n }, ( _, i ) => i );
	const find = ( i ) => { while ( root[ i ] !== i ) i = root[ i ] = root[ root[ i ] ]; return i; };
	for ( let i = 0; i < m; i ++ ) root[ find( ea[ i ] ) ] = find( eb[ i ] );
	const size = new Int32Array( n );
	let biggest = 0;
	for ( let i = 0; i < n; i ++ ) if ( ++ size[ find( i ) ] > size[ biggest ] ) biggest = find( i );
	const connected = Uint8Array.from( { length: n }, ( _, i ) => size[ find( i ) ] >= size[ biggest ] * minComponent ? 1 : 0 );

	return { n, m, lats, lons, xs, zs, offset, adj, edge, len, cost, connected, lat0, lon0, kx, kz };
}

// Nearest node with at least one edge, optionally only among nodes where usable[ i ] is set.
export function nearestNode( g, x, z, usable = null ) {
	let best = - 1, bestD = Infinity;
	for ( let i = 0; i < g.n; i ++ ) {
		if ( g.offset[ i + 1 ] === g.offset[ i ] || ( usable && ! usable[ i ] ) ) continue;
		const d = ( g.xs[ i ] - x ) ** 2 + ( g.zs[ i ] - z ) ** 2;
		if ( d < bestD ) { bestD = d; best = i; }
	}
	return best;
}

// Converts scene metres back to latitude and longitude.
export function toLatLon( g, x, z ) {
	return [ g.lat0 - z / g.kz, g.lon0 + x / g.kx ];
}
