import * as THREE from 'three';
import { lensGLSL } from './glsl.js';

// A material that draws light through the lens: additive, no depth, with lensGLSL ahead of the vertex shader and
// the lens uniforms shared in. See glsl.js for what the shaders are expected to do.
export function createLensMaterial( lens, { uniforms = {}, vertexShader, fragmentShader } ) {
	return new THREE.ShaderMaterial( {
		uniforms: { ...lens, ...uniforms },
		vertexShader: lensGLSL + vertexShader,
		fragmentShader,
		transparent: true,
		depthWrite: false,
		depthTest: false,
		blending: THREE.AdditiveBlending,
	} );
}
