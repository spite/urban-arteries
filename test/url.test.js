import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPlace } from '../src/ui/url.js';

test( 'reads a place with a name', () => {
	assert.deepEqual( readPlace( '#34.06460,-4.97300,F%C3%A8s' ), { place: { lat: 34.0646, lon: - 4.973, name: 'Fès' }, radius: null } );
} );

test( 'keeps commas inside names', () => {
	assert.equal( readPlace( '#1,2,' + encodeURIComponent( 'Rome, Italy' ) ).place.name, 'Rome, Italy' );
} );

test( 'reads an older link with a radius third', () => {
	assert.deepEqual( readPlace( '#41.387,2.1701,1200', { radii: [ 600, 1200 ] } ), { place: { lat: 41.387, lon: 2.1701, name: '41.3870, 2.1701' }, radius: 1200 } );
} );

test( 'ignores hashes without a place', () => {
	for ( const hash of [ '', '#', '#abc', '#12', '#1,x' ] ) assert.equal( readPlace( hash ), null );
} );
