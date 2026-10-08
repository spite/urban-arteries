import * as THREE from 'three';

// The uniforms the lens reads. Share one object between every lens material (createLensMaterial spreads it in),
// so a single write reaches them all. LayeredPass drives the band uniforms and uResolution while it draws.
export function createLensUniforms( { pixelRatio = 1 } = {} ) {
	return {
		uFocus: { value: 1 }, // distance to the focal plane, world units
		uAperture: { value: 0 }, // aperture diameter, world units
		uChroma: { value: 0 }, // longitudinal chromatic aberration: 0 off, 1 strong
		uRim: { value: 0 }, // light pushed to the edge of the bokeh, as spherical aberration does: 0 off, 1 strong
		uPixelRatio: { value: pixelRatio },
		uFullResolution: { value: new THREE.Vector2( 1, 1 ) }, // the screen buffer, in whose pixels blur is measured
		uResolution: { value: new THREE.Vector2( 1, 1 ) }, // the band target being drawn into
		uBand: { value: new THREE.Vector3( 0, 0, 0 ) }, // blur radii of the previous, current and next band
		uBandScale: { value: 1 }, // the band's resolution as a share of the screen buffer's
	};
}
