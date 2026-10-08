import * as THREE from 'three';

// The uniforms every material here reads. Share one object between materials so a single write updates all.
// uExag scales y (height); uGrow/uPulse are path distances for the growth front and the travelling pulse.
export function createUniforms( { pixelRatio = 1 } = {} ) {
	return {
		uGrow: { value: 1e9 },
		uPulse: { value: - 1 },
		uExag: { value: 1 },
		uFocus: { value: 1 },
		uAperture: { value: 0 },
		uSize: { value: 1 },
		uCold: { value: new THREE.Vector3( .32, .5, 1 ) },
		uWarm: { value: new THREE.Vector3( 1, .8, .55 ) },
		uResolution: { value: new THREE.Vector2( 1, 1 ) },
		uPixelRatio: { value: pixelRatio },
	};
}

// Thin-lens defocus. An aperture of diameter A (world units) spreads a point at depth d over A·|d − f| / d at
// the focal plane f; that disc is projected to pixels at the focus distance. A stroke and the disc combine as
// Gaussians, a disc of diameter c matching one of sigma c/4, so widths add in quadrature. Sigma is in
// drawing-buffer pixels; strokeWidth is in CSS pixels.
export const defocusGLSL = /* glsl */`
	uniform float uFocus, uAperture, uSize, uPixelRatio;
	uniform vec2 uResolution;

	float cocPixels( float depth ) {
		float d = max( depth, 1. );
		return uAperture * abs( d - uFocus ) / d * projectionMatrix[ 1 ][ 1 ] * .5 * uResolution.y / max( uFocus, 1. );
	}

	float strokeSigma( float strokeWidth ) {
		return strokeWidth * uSize * uPixelRatio * .25;
	}

	float defocusSigma( float strokeWidth, float depth ) {
		float core = strokeSigma( strokeWidth );
		float coc = cocPixels( depth ) * .25;
		return sqrt( core * core + coc * coc );
	}
`;

// Colour by weight (0 side street … 1 main artery), plus the glow at the growth front and the travelling pulse.
export const arteryColorGLSL = /* glsl */`
	uniform float uGrow, uPulse;
	uniform vec3 uCold, uWarm;

	vec3 arteryColor( float weight, float dist, float base, float gain ) {
		float tip = exp( - max( uGrow - dist, 0. ) / 60. );
		float pulse = uPulse > 0. ? exp( - abs( uPulse - dist ) / 25. ) * ( .3 + weight ) : 0.;
		float t = pow( weight, .5 );
		return mix( uCold, uWarm, t ) * ( base + gain * t ) + uWarm * ( tip + pulse );
	}
`;
