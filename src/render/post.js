import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { LayeredPass } from '../lens/layered-pass.js';

// Film grain on the finished image: triangular noise, fresh every frame (uSeed), lighter in the blacks.
export const GrainShader = {
	uniforms: { tDiffuse: { value: null }, uGrain: { value: 0 }, uSeed: { value: 0 } },
	vertexShader: /* glsl */`
		varying vec2 vUv;
		void main() {
			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1. );
		}
	`,
	fragmentShader: /* glsl */`
		uniform sampler2D tDiffuse;
		uniform float uGrain, uSeed;
		varying vec2 vUv;
		float hash( vec2 p ) {
			vec3 q = fract( vec3( p.xyx ) * .1031 );
			q += dot( q, q.yzx + 33.33 );
			return fract( ( q.x + q.y ) * q.z );
		}
		void main() {
			vec4 c = texture2D( tDiffuse, vUv );
			vec2 p = gl_FragCoord.xy + uSeed * 117.;
			float n = hash( p ) + hash( p + 41.7 ) - 1.;
			float lum = dot( c.rgb, vec3( .2126, .7152, .0722 ) );
			gl_FragColor = vec4( c.rgb + n * uGrain * mix( .35, 1., smoothstep( 0., .5, lum ) ), 1. );
		}
	`,
};

// The frame from scene to screen: the scene as light through the lens (LayeredPass) into a half-float target,
// bloom, ACES tone mapping with exposure, then grain. Set renderer.toneMapping for the tone mapping to apply.
export function createPost( renderer, scene, camera, lens ) {
	const composer = new EffectComposer( renderer );
	composer.addPass( new LayeredPass( scene, camera, lens ) );
	const bloom = new UnrealBloomPass( new THREE.Vector2( 1, 1 ), .3, 0, 1 );
	// Weighted toward the tight levels: the widest would smear the whole picture's light into a haze over the frame.
	bloom.compositeMaterial.uniforms.bloomFactors.value = [ 1, .5, .2, .05, 0 ];
	composer.addPass( bloom );
	composer.addPass( new OutputPass() );
	const grain = new ShaderPass( GrainShader );
	composer.addPass( grain );

	return {
		composer,
		setSize( width, height ) {
			composer.setSize( width, height );
		},
		setPixelRatio( ratio ) {
			composer.setPixelRatio( ratio );
		},
		setLook( { exposure = 1, bloom: strength = .3, grain: amount = 0 } = {} ) {
			renderer.toneMappingExposure = exposure;
			bloom.strength = strength;
			grain.uniforms.uGrain.value = amount;
			grain.enabled = amount > 0;
		},
		render() {
			grain.uniforms.uSeed.value = Math.random();
			composer.render();
		},
		dispose() {
			for ( const pass of composer.passes ) pass.dispose?.();
			composer.dispose();
		},
	};
}
