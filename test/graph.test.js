import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, nearestNode, toLatLon, walkable } from '../src/graph/graph.js';
import { shortestPathTree } from '../src/graph/dijkstra.js';
import { FES, fesElements } from './helpers.js';

const g = buildGraph( fesElements(), FES.lat, FES.lon );

test( 'builds a mostly connected walking network', () => {
	assert.ok( g.n > 5000 && g.m > 5000 );
	const share = g.connected.reduce( ( a, b ) => a + b, 0 ) / g.n;
	assert.ok( share > .9, `connected share ${share}` );
} );

test( 'projects around the origin and back', () => {
	const v = nearestNode( g, 100, - 200 );
	const [ lat, lon ] = toLatLon( g, g.xs[ v ], g.zs[ v ] );
	assert.ok( Math.abs( lat - g.lats[ v ] ) < 1e-9 && Math.abs( lon - g.lons[ v ] ) < 1e-9 );
} );

test( 'leaves out corridors and cycle lanes closed to walkers', () => {
	assert.equal( walkable( { highway: 'corridor' } ), false );
	assert.equal( walkable( { highway: 'cycleway' } ), false );
	assert.equal( walkable( { highway: 'cycleway', foot: 'yes' } ), true );
	assert.equal( walkable( { highway: 'residential' } ), true );
} );

test( 'shortest paths never beat the straight line, and goals stop the search early', () => {
	const origin = nearestNode( g, 0, 0, g.connected );
	const full = shortestPathTree( g, origin, g.len );
	for ( let v = 0; v < g.n; v += 97 ) {
		if ( full.dist[ v ] === Infinity ) continue;
		assert.ok( full.dist[ v ] + 1e-6 >= Math.hypot( g.xs[ v ] - g.xs[ origin ], g.zs[ v ] - g.zs[ origin ] ) );
	}
	const goal = nearestNode( g, 50, 50, g.connected );
	const early = shortestPathTree( g, origin, g.len, { goals: [ goal ] } );
	assert.ok( early.order.length < full.order.length );
	assert.equal( early.dist[ goal ], full.dist[ goal ] );
} );
