// Vertex-shader helpers for drawing light through the lens; createLensMaterial() prepends them.
//
// The contract for a lens material: draw everything sharp, sized with bandPixels(), and multiply its light by
// bandWeights( blurRadii( depth ) ). LayeredPass draws the scene once per blur band, blurs each band by the
// aperture and adds them up, so each stroke ends up blurred by its own radius, per colour channel.
export const lensGLSL = /* glsl */`
	uniform float uFocus, uAperture, uChroma, uPixelRatio, uBandScale;
	uniform vec2 uResolution, uFullResolution;
	uniform vec3 uBand;

	// Thin lens: an aperture of diameter A spreads a point at depth d into a disc of diameter A·|d − f| / d at the
	// focal plane f, projected to pixels at the focus distance. Red and blue focus a little farther than green, so
	// blur fringes magenta in front of focus and green behind. Radii per channel, in screen-buffer pixels.
	vec3 blurRadii( float depth ) {
		float d = max( depth, 1. );
		vec3 focus = uFocus * ( 1. + uChroma * .04 * vec3( 1., - 1., 1. ) );
		vec3 diameter = uAperture * abs( d - focus ) / d * projectionMatrix[ 1 ][ 1 ] * .5 * uFullResolution.y / max( uFocus, 1. );
		return diameter * .5;
	}

	// The share of a stroke's light that belongs to the band being drawn. A radius between two bands is split
	// linearly between them, so the steps between bands don't show.
	float bandWeight( float R ) {
		float lo = uBand.x, mid = uBand.y, hi = uBand.z;
		if ( R <= mid ) return mid <= lo ? 1. : clamp( ( R - lo ) / ( mid - lo ), 0., 1. );
		return hi <= mid ? 1. : clamp( ( hi - R ) / ( hi - mid ), 0., 1. );
	}

	vec3 bandWeights( vec3 R ) {
		return vec3( bandWeight( R.r ), bandWeight( R.g ), bandWeight( R.b ) );
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
