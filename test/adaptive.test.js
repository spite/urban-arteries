import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdaptiveScale } from '../src/render/adaptive.js';

test( 'drops resolution while frames are slow and recovers when fast', () => {
	const seen = [];
	const adaptive = createAdaptiveScale( ( s ) => seen.push( s ), { min: .4 } );
	for ( let i = 0; i < 400; i ++ ) adaptive.frame( 50 );
	assert.equal( adaptive.scale, .4 );
	for ( let i = 0; i < 3000; i ++ ) adaptive.frame( 8 );
	assert.equal( adaptive.scale, 1 );
	assert.ok( seen.length > 4 );
} );

test( 'holds the ceiling when adaptation is off', () => {
	const adaptive = createAdaptiveScale( () => {} );
	adaptive.setCeiling( .75 );
	adaptive.setEnabled( false );
	for ( let i = 0; i < 400; i ++ ) adaptive.frame( 50 );
	assert.equal( adaptive.scale, .75 );
} );
