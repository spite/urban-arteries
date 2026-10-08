import * as THREE from 'three';

// The uniforms every material here reads. Share one object between materials so a single write updates all.
// uExag scales y (height); uGrow/uPulse are path distances for the growth front and the travelling pulse.
// uChroma is longitudinal chromatic aberration (0 off, 1 strong); uRim brightens the edge of the bokeh.
// uResolution is the target being drawn and uFullResolution the screen's buffer, which blur radii are measured in;
// they only differ in the layered pipeline, where uBin and uBinScale describe the blur band being drawn.
export function createUniforms( { pixelRatio = 1 } = {} ) {
	return {
		uGrow: { value: 1e9 },
		uPulse: { value: - 1 },
		uExag: { value: 1 },
		uFocus: { value: 1 },
		uAperture: { value: 0 },
		uSize: { value: 1 },
		uChroma: { value: 0 },
		uRim: { value: 0 },
		uCold: { value: new THREE.Vector3( .32, .5, 1 ) },
		uWarm: { value: new THREE.Vector3( 1, .8, .55 ) },
		uResolution: { value: new THREE.Vector2( 1, 1 ) },
		uFullResolution: { value: new THREE.Vector2( 1, 1 ) },
		uPixelRatio: { value: pixelRatio },
		uBin: { value: new THREE.Vector3( 0, 0, 0 ) },
		uBinScale: { value: 1 },
	};
}

// Thin-lens defocus, for vertex shaders. An aperture of diameter A (world units) spreads a point at depth d into
// a disc of diameter A·|d − f| / d at the focal plane f, projected to pixels at the focus distance. Red and blue
// focus a little farther than green, so blur in front of focus fringes magenta and behind it green.
// Radii are per channel in full-screen buffer pixels. blurRadii() never goes below 0.7 px so in-focus edges stay
// antialiased when the blur is drawn analytically; the layered pipeline wants the exact value, exactBlurRadii().
export const defocusGLSL = /* glsl */`
	uniform float uFocus, uAperture, uSize, uPixelRatio, uChroma;
	uniform vec2 uResolution, uFullResolution;

	vec3 exactBlurRadii( float depth ) {
		float d = max( depth, 1. );
		vec3 focus = uFocus * ( 1. + uChroma * .04 * vec3( 1., - 1., 1. ) );
		vec3 diameter = uAperture * abs( d - focus ) / d * projectionMatrix[ 1 ][ 1 ] * .5 * uFullResolution.y / max( uFocus, 1. );
		return diameter * .5;
	}

	vec3 blurRadii( float depth ) {
		return max( exactBlurRadii( depth ), .7 );
	}

	// Half the drawn width of a stroke in focus, in drawing-buffer pixels; strokeWidth is in CSS pixels.
	float strokeRadius( float strokeWidth ) {
		return strokeWidth * uSize * uPixelRatio * .35;
	}
`;

// What a stroke looks like through that lens, for fragment shaders. Each is the stroke convolved with the
// aperture disc of radius R, so total light is kept: a bar of half-width rs becomes a flat-topped band with
// semicircular shoulders (line), a dot of radius rs becomes a bokeh disc (spot), and a line's end rounds off over
// R (end). In focus R is under a pixel and they reduce to crisp, antialiased shapes. uRim moves light toward the
// edge of the blur, as spherical aberration does, only in proportion to how defocused the stroke is.
export const profileGLSL = /* glsl */`
	uniform float uRim;
	const float PI = 3.14159265;

	// Share of a disc of radius R lying between its centre and offset t (the integral of its line-spread function).
	float discShare( float t, float R ) {
		float s = clamp( t / R, - 1., 1. );
		return ( s * sqrt( max( 1. - s * s, 0. ) ) + asin( s ) ) / PI;
	}

	float rim( float u, float rs, float R ) {
		return 1. + uRim * R / ( R + rs ) * ( pow( clamp( u, 0., 1. ), 4. ) * 3. - .6 );
	}

	float line( float x, float rs, float R ) {
		return ( discShare( x + rs, R ) - discShare( x - rs, R ) ) * rim( x / ( rs + R ), rs, R );
	}

	float end( float y, float R ) {
		return clamp( 1. - 2. * discShare( y, R ), 0., 1. );
	}

	float overlap( float d, float a, float b ) {
		if ( d >= a + b ) return 0.;
		if ( d <= abs( a - b ) ) return PI * min( a, b ) * min( a, b );
		float k = sqrt( max( ( - d + a + b ) * ( d + a - b ) * ( d - a + b ) * ( d + a + b ), 0. ) );
		return a * a * acos( clamp( ( d * d + a * a - b * b ) / ( 2. * d * a ), - 1., 1. ) )
			+ b * b * acos( clamp( ( d * d + b * b - a * a ) / ( 2. * d * b ), - 1., 1. ) ) - .5 * k;
	}

	float spot( float d, float rs, float R ) {
		return overlap( d, rs, R ) / ( PI * R * R ) * rim( d / ( rs + R ), rs, R );
	}

	vec3 line3( float x, float rs, vec3 R ) { return vec3( line( x, rs, R.r ), line( x, rs, R.g ), line( x, rs, R.b ) ); }
	vec3 end3( float y, vec3 R ) { return vec3( end( y, R.r ), end( y, R.g ), end( y, R.b ) ); }
	vec3 spot3( float d, float rs, vec3 R ) { return vec3( spot( d, rs, R.r ), spot( d, rs, R.g ), spot( d, rs, R.b ) ); }
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

// Which share of a stroke's light belongs to the blur band being drawn: bands sit at radii uBin = ( previous, this,
// next ) and a radius between two of them is split linearly, per colour channel, so nothing bands visibly.
export const binGLSL = /* glsl */`
	uniform vec3 uBin;
	uniform float uBinScale;

	float binWeight( float R ) {
		float lo = uBin.x, mid = uBin.y, hi = uBin.z;
		if ( R <= mid ) return mid <= lo ? 1. : clamp( ( R - lo ) / ( mid - lo ), 0., 1. );
		return hi <= mid ? 1. : clamp( ( hi - R ) / ( hi - mid ), 0., 1. );
	}

	vec3 binWeights( vec3 R ) {
		return vec3( binWeight( R.r ), binWeight( R.g ), binWeight( R.b ) );
	}
`;
