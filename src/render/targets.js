import * as THREE from 'three';
import { defocusGLSL, profileGLSL } from './chunks.js';

// A point at each destination ({ point: [ x, y, z ], dist }), lit until the growth front nears it and fading out
// over the last uFade metres of path, so the dots are collected as the routes arrive. Blurred into bokeh like
// the particles.
export function targetGeometry( targets ) {
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( new Float32Array( targets.flatMap( ( t ) => t.point ) ), 3 ) );
	geometry.setAttribute( 'aDist', new THREE.BufferAttribute( new Float32Array( targets.map( ( t ) => t.dist ) ), 1 ) );
	return geometry;
}

// Uniforms come from createUniforms(), plus its own uFade (metres of path over which a dot fades).
export function createTargetMaterial( uniforms ) {
	return new THREE.ShaderMaterial( {
		uniforms: { ...uniforms, uFade: { value: 100 } },
		transparent: true,
		depthWrite: false,
		blending: THREE.AdditiveBlending,
		vertexShader: /* glsl */`
			uniform float uGrow, uExag, uFade;
			${defocusGLSL}
			attribute float aDist;
			varying float vFade, vStroke, vSize;
			varying vec3 vBlur;

			void main() {
				vec4 mv = modelViewMatrix * vec4( position * vec3( 1., uExag, 1. ), 1. );
				vStroke = strokeRadius( 6. );
				vBlur = min( blurRadii( - mv.z ), 250. );
				vSize = 2. * ( vStroke + max( vBlur.r, max( vBlur.g, vBlur.b ) ) + 1. );
				vFade = smoothstep( 0., uFade, aDist - uGrow );
				gl_Position = vFade > 0. ? projectionMatrix * mv : vec4( 2., 2., 2., 1. );
				gl_PointSize = vFade > 0. ? vSize : 0.;
			}
		`,
		fragmentShader: /* glsl */`
			uniform vec3 uCold, uWarm;
			${profileGLSL}
			varying float vFade, vStroke, vSize;
			varying vec3 vBlur;

			void main() {
				float d = length( gl_PointCoord - .5 ) * vSize;
				if ( d > vStroke + max( vBlur.r, max( vBlur.g, vBlur.b ) ) ) discard;
				vec3 f = abs( vBlur.r - vBlur.g ) + abs( vBlur.b - vBlur.g ) < .25 ? vec3( spot( d, vStroke, vBlur.g ) ) : spot3( d, vStroke, vBlur );
				gl_FragColor = vec4( mix( uCold, vec3( 1. ), .6 ) * f * vFade, 1. );
			}
		`,
	} );
}
