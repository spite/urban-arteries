import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, nearestNode } from '../src/graph/graph.js';
import { route, branches, toPaths, toDestinations, routeExtent } from '../src/graph/routes.js';
import { FES, fesElements } from './helpers.js';

const g = buildGraph( fesElements(), FES.lat, FES.lon );
const origin = nearestNode( g, 0, 0, g.connected );
const length = ( r ) => r.segs.reduce( ( s, { u, v } ) => s + Math.hypot( g.xs[ u ] - g.xs[ v ], g.zs[ u ] - g.zs[ v ] ), 0 );

test( 'routes to the requested destinations, oriented away from the origin', async () => {
	const r = await route( g, origin, { radius: FES.radius, count: 200 } );
	assert.equal( r.destinations.length, 200 );
	for ( const { u, v, flow } of r.segs ) {
		assert.ok( flow > 0 );
		assert.ok( r.dist[ u ] < r.dist[ v ] );
	}
	assert.ok( r.destinations.every( ( v ) => r.dist[ v ] < Infinity ) );
} );

test( 'is deterministic', async () => {
	const a = await route( g, origin, { radius: FES.radius, count: 300, layout: 'scatter' } );
	const b = await route( g, origin, { radius: FES.radius, count: 300, layout: 'scatter' } );
	assert.deepEqual( a.segs, b.segs );
} );

test( 'bundling draws less street than none', async () => {
	const loose = await route( g, origin, { radius: FES.radius, count: 300, bundling: 0 } );
	const tight = await route( g, origin, { radius: FES.radius, count: 300, bundling: 1 } );
	assert.ok( length( tight ) < length( loose ) * .9, `${length( tight )} vs ${length( loose )}` );
} );

test( 'ring destinations sit near the edge of the network', async () => {
	const r = await route( g, origin, { radius: FES.radius, count: 200, layout: 'ring', depth: .1 } );
	const reach = r.destinations.map( ( v ) => Math.hypot( g.xs[ v ], g.zs[ v ] ) / FES.radius ).sort( ( a, b ) => a - b );
	assert.ok( reach[ Math.floor( reach.length * .1 ) ] > .6, `10th percentile ${reach[ Math.floor( reach.length * .1 ) ]}` );
} );

test( 'can be cancelled between rounds', async () => {
	let rounds = 0;
	const r = await route( g, origin, { radius: FES.radius, count: 100 }, { onRound: () => rounds ++, cancelled: () => rounds >= 2 } );
	assert.equal( r, null );
} );

test( 'branches cover every drawn segment exactly once and become paths', async () => {
	const r = await route( g, origin, { radius: FES.radius, count: 200 } );
	const polylines = branches( r );
	assert.equal( polylines.reduce( ( s, { nodes } ) => s + nodes.length - 1, 0 ), r.segs.length );
	const paths = toPaths( g, new Float32Array( g.n ), r.dist, polylines );
	for ( const p of paths ) assert.ok( p.points.length === p.dist.length && p.dist.length === p.weight.length );
	assert.equal( toDestinations( g, new Float32Array( g.n ), r ).length, r.destinations.length );
	assert.ok( routeExtent( g, r ) > 0 && routeExtent( g, r ) <= FES.radius * 1.25 );
} );

test( 'every street mode draws the tree to the whole circle', async () => {
	const r = await route( g, origin, { algorithm: 'all', radius: FES.radius } );
	assert.equal( r.destinations.length, 0 );
	assert.ok( r.segs.length > 1000 );
} );
