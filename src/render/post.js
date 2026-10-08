import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { OutputShader } from 'three/addons/shaders/OutputShader.js';
import { LayeredPass } from '../lens/layered-pass.js';

// OutputPass (tone mapping with exposure, output colour space) with film grain on top in the same pass: triangular
// noise, fresh every frame (uSeed), lighter in the blacks.
export class FinishPass extends OutputPass {
	constructor() {
		super();
		this.material.dispose();
		this.uniforms = { ...THREE.UniformsUtils.clone( OutputShader.uniforms ), uGrain: { value: 0 }, uSeed: { value: 0 } };
		this.material = this.fsQuad.material = new THREE.RawShaderMaterial( {
			uniforms: this.uniforms,
			vertexShader: OutputShader.vertexShader,
			fragmentShader: /* glsl */`
				precision highp float;
				uniform sampler2D tDiffuse;
				uniform float uGrain, uSeed;
				#include <tonemapping_pars_fragment>
				#include <colorspace_pars_fragment>
				varying vec2 vUv;
				float hash( vec2 p ) {
					vec3 q = fract( vec3( p.xyx ) * .1031 );
					q += dot( q, q.yzx + 33.33 );
					return fract( ( q.x + q.y ) * q.z );
				}
				void main() {
					vec4 c = texture2D( tDiffuse, vUv );
					#ifdef ACES_FILMIC_TONE_MAPPING
						c.rgb = ACESFilmicToneMapping( c.rgb );
					#elif defined( NEUTRAL_TONE_MAPPING )
						c.rgb = NeutralToneMapping( c.rgb );
					#elif defined( AGX_TONE_MAPPING )
						c.rgb = AgXToneMapping( c.rgb );
					#endif
					#ifdef SRGB_TRANSFER
						c = sRGBTransferOETF( c );
					#endif
					vec2 p = gl_FragCoord.xy + uSeed * 117.;
					float n = hash( p ) + hash( p + 41.7 ) - 1.;
					float lum = dot( c.rgb, vec3( .2126, .7152, .0722 ) );
					gl_FragColor = vec4( c.rgb + n * uGrain * mix( .35, 1., smoothstep( 0., .5, lum ) ), 1. );
				}
			`,
		} );
	}
}

// The frame from scene to screen: the scene as light through the lens (LayeredPass) into a half-float target,
// bloom, ACES tone mapping with exposure, then grain. Set renderer.toneMapping for the tone mapping to apply.
export function createPost( renderer, scene, camera, lens ) {
	const composer = new EffectComposer( renderer );
	const layered = new LayeredPass( scene, camera, lens );
	composer.addPass( layered );
	const bloom = new UnrealBloomPass( new THREE.Vector2( 1, 1 ), .3, 0, 1 );
	// Weighted toward the tight levels: the widest would smear the whole picture's light into a haze over the frame.
	bloom.compositeMaterial.uniforms.bloomFactors.value = [ 1, .5, .2, .05, 0 ];
	composer.addPass( bloom );
	const finish = new FinishPass();
	composer.addPass( finish );

	return {
		composer,
		setSize( width, height ) {
			composer.setSize( width, height );
		},
		setPixelRatio( ratio ) {
			composer.setPixelRatio( ratio );
		},
		setLook( { exposure = 1, bloom: strength = .3, bloomThreshold = 1, grain: amount = 0 } = {} ) {
			renderer.toneMappingExposure = exposure;
			bloom.strength = strength;
			bloom.threshold = bloomThreshold;
			bloom.enabled = strength > 0;
			finish.uniforms.uGrain.value = amount;
		},
		// Rebuilds the depth-of-field bands; see LayeredPass.configure().
		setBands( options ) {
			layered.configure( options );
		},
		// What LayeredPass outputs; see its `debug`.
		setDebug( debug ) {
			Object.assign( layered.debug, debug );
		},
		// A THREE.Sphere around everything drawn, or null; lets the depth of field skip bands nothing reaches.
		setBounds( bounds ) {
			layered.bounds = bounds;
		},
		get bands() {
			return layered.info;
		},
		render() {
			finish.uniforms.uSeed.value = Math.random();
			composer.render();
		},
		dispose() {
			for ( const pass of composer.passes ) pass.dispose?.();
			composer.dispose();
		},
	};
}
