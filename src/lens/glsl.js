// Vertex-shader helpers for drawing light through the lens; createLensMaterial() prepends them.
//
// The contract for a lens material: draw everything sharp, sized with bandPixels(), and multiply its light by
// bandWeight( blurRadius( depth ) ). LayeredPass draws the scene once per blur band, blurs each band by the
// aperture and adds them up, so each stroke ends up blurred by its own radius.
export const lensGLSL = /* glsl */`
	uniform float uFocus, uAperture, uPixelRatio, uBandScale, uBandBlend;
	uniform vec2 uResolution, uFullResolution;
	uniform vec3 uBand;

	// Thin lens: an aperture of diameter A spreads a point at depth d into a disc of diameter A·|d − f| / d at the
	// focal plane f, projected to pixels at the focus distance. The radius, in screen-buffer pixels.
	float blurRadius( float depth ) {
		float d = max( depth, 1. );
		return uAperture * abs( d - uFocus ) / d * projectionMatrix[ 1 ][ 1 ] * .25 * uFullResolution.y / max( uFocus, 1. );
	}

	// The share of a stroke's light that belongs to the band being drawn. A radius between two bands is split
	// linearly between them, so the steps between bands don't show; with uBandBlend off it goes to the nearest.
	float bandWeight( float R ) {
		float lo = uBand.x, mid = uBand.y, hi = uBand.z;
		if ( uBandBlend < .5 ) return ( mid <= lo || R >= .5 * ( lo + mid ) ) && ( hi <= mid || R < .5 * ( mid + hi ) ) ? 1. : 0.;
		if ( R <= mid ) return mid <= lo ? 1. : clamp( ( R - lo ) / ( mid - lo ), 0., 1. );
		return hi <= mid ? 1. : clamp( ( hi - R ) / ( hi - mid ), 0., 1. );
	}

	// CSS pixels to pixels of the band being drawn.
	float bandPixels( float cssPixels ) {
		return cssPixels * uPixelRatio * uBandScale;
	}

	// Clip space to pixels of the band being drawn, origin at the centre.
	vec2 bandScreen( vec4 clip ) {
		return clip.xy / clip.w * .5 * uResolution;
	}
`;
