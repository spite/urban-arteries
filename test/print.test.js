import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, nearestNode } from '../src/graph/graph.js';
import { route, branches, toPaths } from '../src/graph/routes.js';
import { buildPrintModel } from '../src/print/model.js';
import { FES, fesElements } from './helpers.js';

const g = buildGraph( fesElements(), FES.lat, FES.lon );
const routes = await route( g, nearestNode( g, 0, 0, g.connected ), { radius: FES.radius, count: 100 } );
const ground = ( x, z ) => 20 * Math.exp( - ( x * x + z * z ) / 300 ** 2 );
const heights = Float32Array.from( g.xs, ( x, i ) => ground( x, g.zs[ i ] ) );
const paths = toPaths( g, heights, routes.dist, branches( routes ) );

// Reads a binary STL back: every edge must be met once in each direction, i.e. every shell closed and consistently wound.
async function inspect( blob ) {
	const buf = Buffer.from( await blob.arrayBuffer() );
	const count = buf.readUInt32LE( 80 );
	const edges = new Map(), min = [ Infinity, Infinity, Infinity ], max = [ - Infinity, - Infinity, - Infinity ];
	const key = ( o ) => [ 0, 4, 8 ].map( ( d ) => buf.readFloatLE( o + d ).toFixed( 4 ) ).join( ',' );
	for ( let t = 0; t < count; t ++ ) {
		const o = 84 + t * 50 + 12, v = [ key( o ), key( o + 12 ), key( o + 24 ) ];
		for ( let k = 0; k < 3; k ++ ) {
			const e = v[ k ] + '>' + v[ ( k + 1 ) % 3 ];
			edges.set( e, ( edges.get( e ) || 0 ) + 1 );
			for ( let c = 0; c < 3; c ++ ) {
				const x = buf.readFloatLE( o + k * 12 + c * 4 );
				min[ c ] = Math.min( min[ c ], x );
				max[ c ] = Math.max( max[ c ], x );
			}
		}
	}
	let open = 0;
	for ( const [ e, n ] of edges ) {
		const [ a, b ] = e.split( '>' );
		if ( a !== b && ( edges.get( b + '>' + a ) || 0 ) !== n ) open ++;
	}
	return { count, open, size: max.map( ( x, c ) => x - min[ c ] ) };
}

for ( const base of [ 'relief', 'plate', 'none' ] ) {
	test( `${base}: closed, consistently wound shells at the requested size`, async () => {
		const { blob, triangles } = buildPrintModel( paths, { radius: FES.radius, size: 120, exag: 2, base, ground } );
		const { count, open, size } = await inspect( blob );
		assert.equal( count, triangles );
		assert.equal( open, 0 );
		if ( base !== 'none' ) assert.ok( Math.abs( size[ 0 ] - 120 ) < .5 && Math.abs( size[ 1 ] - 120 ) < .5, `size ${size}` );
	} );
}
