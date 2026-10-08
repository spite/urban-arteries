import * as THREE from 'three';

// A glowing point with a ring pulsing out of it, drawn at a fixed screen size. Advance it by setting
// marker.material.uniforms.uTime. Reads uExag and uPixelRatio from the shared uniforms.
export function createMarker( uniforms, position = [ 0, 0, 0 ] ) {
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( position, 3 ) );
	const material = new THREE.ShaderMaterial( {
		uniforms: { ...uniforms, uTime: { value: 0 } },
		transparent: true,
		depthWrite: false,
		blending: THREE.AdditiveBlending,
		vertexShader: /* glsl */`
			uniform float uExag, uPixelRatio;
			void main() {
				gl_Position = projectionMatrix * modelViewMatrix * vec4( position * vec3( 1., uExag, 1. ), 1. );
				gl_PointSize = 48. * uPixelRatio;
			}
		`,
		fragmentShader: /* glsl */`
			uniform float uTime;
			void main() {
				float d = length( gl_PointCoord - .5 ) * 2.;
				float ring = exp( - abs( d - fract( uTime * .5 ) ) * 20. ) * ( 1. - fract( uTime * .5 ) );
				float core = exp( - d * 9. );
				gl_FragColor = vec4( vec3( 1., .85, .6 ) * ( core * 1.5 + ring ), 1. );
			}
		`,
	} );
	const marker = new THREE.Points( geometry, material );
	marker.frustumCulled = false;
	return marker;
}
