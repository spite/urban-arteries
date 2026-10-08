import { test } from 'node:test';
import assert from 'node:assert/strict';

// Hits OpenFreeMap and Overpass: only with ONLINE=1 (npm run test:online), after npm install.
const online = { skip: ! process.env.ONLINE && 'online test, run with ONLINE=1' };

test( 'map tiles re-node into a connected network', online, async () => {
	const { fetchStreetsFromTiles } = await import( '../src/streets/tiles.js' );
	const { buildGraph } = await import( '../src/graph/graph.js' );
	const els = await fetchStreetsFromTiles( 41.387, 2.1701, 900 );
	const g = buildGraph( els, 41.387, 2.1701 );
	assert.ok( g.connected.reduce( ( a, b ) => a + b, 0 ) / g.n > .95 );
} );

test( 'overpass returns the same kind of elements', online, async () => {
	const { fetchStreetsFromOverpass } = await import( '../src/streets/overpass.js' );
	const els = await fetchStreetsFromOverpass( 34.0646, - 4.973, 300, { headers: { 'User-Agent': 'urban-arteries tests' } } );
	assert.ok( els.some( ( e ) => e.type === 'way' && e.tags?.highway ) && els.some( ( e ) => e.type === 'node' ) );
} );
