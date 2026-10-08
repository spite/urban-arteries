import * as THREE from 'three';
import { defocusGLSL, arteryColorGLSL, profileGLSL } from './chunks.js';

// Particles scattered along paths ({ points, dist, weight }) at roughly `spacing` apart, jittered along each
// segment so they never line up into dots.
export function particleGeometry( paths, { spacing, random = Math.random } ) {
	let total = 0;
	for ( const { points } of paths ) {
		for ( let i = 1; i < points.length; i ++ ) total += segmentCount( points[ i - 1 ], points[ i ], spacing );
	}
	const position = new Float32Array( total * 3 ), aDist = new Float32Array( total ), aW = new Float32Array( total );
	let p = 0;
	for ( const { points, dist, weight } of paths ) {
		for ( let i = 1; i < points.length; i ++ ) {
			const a = points[ i - 1 ], b = points[ i ], n = segmentCount( a, b, spacing );
			for ( let j = 0; j < n; j ++, p ++ ) {
				const t = ( j + random() ) / n;
				for ( let c = 0; c < 3; c ++ ) position[ p * 3 + c ] = a[ c ] + ( b[ c ] - a[ c ] ) * t;
				aDist[ p ] = dist[ i - 1 ] + ( dist[ i ] - dist[ i - 1 ] ) * t;
				aW[ p ] = weight[ i ];
			}
		}
	}
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( position, 3 ) );
	geometry.setAttribute( 'aDist', new THREE.BufferAttribute( aDist, 1 ) );
	geometry.setAttribute( 'aW', new THREE.BufferAttribute( aW, 1 ) );
	return geometry;
}

function segmentCount( a, b, spacing ) {
	return Math.max( 1, Math.round( Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ], b[ 2 ] - a[ 2 ] ) / spacing ) );
}

// Sprites drawn as light: each is a dot blurred by the lens aperture (profileGLSL) into a bokeh disc, per colour
// channel, keeping its total light however far it is defocused. Uniforms come from createUniforms().
export function createParticleMaterial( uniforms ) {
	return new THREE.ShaderMaterial( {
		uniforms,
		transparent: true,
		depthWrite: false,
		blending: THREE.AdditiveBlending,
		vertexShader: /* glsl */`
			uniform float uGrow, uExag;
			${defocusGLSL}
			attribute float aDist, aW;
			varying float vW, vDist, vStroke, vSize;
			varying vec3 vBlur;

			void main() {
				vec4 mv = modelViewMatrix * vec4( position * vec3( 1., uExag, 1. ), 1. );
				vStroke = strokeRadius( 1.6 + 4. * aW );
				vBlur = min( blurRadii( - mv.z ), 250. );
				vSize = 2. * ( vStroke + max( vBlur.r, max( vBlur.g, vBlur.b ) ) + 1. );
				vW = aW;
				vDist = aDist;
				bool visible = aDist <= uGrow;
				gl_Position = visible ? projectionMatrix * mv : vec4( 2., 2., 2., 1. );
				gl_PointSize = visible ? vSize : 0.;
			}
		`,
		fragmentShader: /* glsl */`
			${arteryColorGLSL}
			${profileGLSL}
			varying float vW, vDist, vStroke, vSize;
			varying vec3 vBlur;

			void main() {
				float d = length( gl_PointCoord - .5 ) * vSize;
				if ( d > vStroke + max( vBlur.r, max( vBlur.g, vBlur.b ) ) ) discard;
				vec3 f = abs( vBlur.r - vBlur.g ) + abs( vBlur.b - vBlur.g ) < .25 ? vec3( spot( d, vStroke, vBlur.g ) ) : spot3( d, vStroke, vBlur );
				gl_FragColor = vec4( arteryColor( vW, vDist, .3, .7 ) * f * .7, 1. );
			}
		`,
	} );
}
