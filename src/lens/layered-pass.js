import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// Layered depth of field, as an EffectComposer pass in place of a RenderPass. The scene is drawn sharp once per
// blur band (lens materials put each stroke's light into the bands either side of its blur radius), each band is
// blurred by the aperture disc, and the bands are added up. A band is rendered at a resolution where its blur is
// only `texels` wide, so the cost hardly depends on how blurred or how dense the scene is. Everything drawn is
// light that adds up with nothing hiding anything else, so adding the bands back together is exact.
//
// Bands are processed from the blurriest up: each band's blur pass also adds the bands below it, upscaled one
// step, so the final full-size pass only reads two images. With `bounds` set, bands no stroke can reach from the
// current viewpoint are skipped altogether.

// Blur radii in screen-buffer pixels: 0 (sharp), then `count` - 1 bands spaced evenly in ratio from `first` to
// `largest`; blur beyond the largest stays at it. More bands mean finer steps between blur sizes.
export function bandRadii( { count = 9, first = 2, largest = 256 } = {} ) {
	const steps = count - 2;
	return Array.from( { length: count }, ( _, i ) => i === 0 ? 0 : steps <= 0 ? largest : first * ( largest / first ) ** ( ( i - 1 ) / steps ) );
}

const quadVertex = /* glsl */`
	varying vec2 vUv;
	void main() {
		vUv = uv;
		gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1. );
	}
`;

// Cubic B-spline lookup from four bilinear taps; smoother than bilinear when a low-resolution band is upscaled.
const cubicGLSL = /* glsl */`
	vec3 cubic( sampler2D t, vec2 uv, vec2 size ) {
		vec2 p = uv * size - .5, i = floor( p ), f = p - i;
		vec2 f2 = f * f, f3 = f2 * f;
		vec2 w0 = ( 1. - 3. * f + 3. * f2 - f3 ) / 6., w1 = ( 4. - 6. * f2 + 3. * f3 ) / 6.;
		vec2 w2 = ( 1. + 3. * f + 3. * f2 - 3. * f3 ) / 6., w3 = f3 / 6.;
		vec2 s0 = w0 + w1, s1 = w2 + w3;
		vec2 h0 = ( i - .5 + w1 / s0 ) / size, h1 = ( i + 1.5 + w3 / s1 ) / size;
		return s0.y * ( s0.x * texture2D( t, h0 ).rgb + s1.x * texture2D( t, vec2( h1.x, h0.y ) ).rgb )
			+ s1.y * ( s0.x * texture2D( t, vec2( h0.x, h1.y ) ).rgb + s1.x * texture2D( t, h1 ).rgb );
	}
`;

export class LayeredPass extends Pass {
	// lens: the uniforms from createLensUniforms(); this pass drives uBand, uBandScale and uResolution.
	constructor( scene, camera, lens, options = {} ) {
		super();
		this.needsSwap = false;
		this.scene = scene;
		this.camera = camera;
		this.lens = lens;
		this.size = [ 1, 1 ];
		this.bands = [];
		// A THREE.Sphere around everything drawn, in world space; lets bands no stroke can reach be skipped.
		this.bounds = null;
		// view: 'final', 'grid' (every band tiled) or 'band' (one band, `band`); stage: 'blurred' or 'sharp' band
		// images; gain brightens what a debug view shows.
		this.debug = { view: 'final', band: 0, stage: 'blurred', gain: 1 };
		this.configure( options );
	}

	// radii: band blur radii (bandRadii()); texels: how wide each band's blur is in its own pixels, which sets its
	// resolution; taps: samples per aperture disc; cubic: smooth upscaling between bands.
	configure( { radii = bandRadii(), texels = 3, taps = 48, cubic = true } = {} ) {
		this.disposeBands();
		this.radii = radii;
		const options = { type: THREE.HalfFloatType, depthBuffer: false };
		this.bands = radii.map( ( radius ) => {
			const scale = radius > 0 ? Math.min( 1, texels / radius ) : 1;
			return {
				radius,
				scale,
				target: new THREE.WebGLRenderTarget( 1, 1, options ),
				blurred: radius > 0 ? new THREE.WebGLRenderTarget( 1, 1, options ) : null,
			};
		} );
		const upscale = ( t, size ) => cubic ? `cubic( ${t}, vUv, ${size} )` : `texture2D( ${t}, vUv ).rgb`;

		// The aperture disc as a Vogel spiral of taps, weighted toward its rim by uRim, plus (uLower) the bands below,
		// already added up, upscaled from their own resolution.
		this.blur = new FullScreenQuad( new THREE.ShaderMaterial( {
			uniforms: {
				tMap: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1 }, uRim: this.lens.uRim,
				tLower: { value: null }, uLowerSize: { value: new THREE.Vector2( 1, 1 ) }, uLower: { value: 0 }, uLowerFull: { value: 1 },
			},
			vertexShader: quadVertex,
			fragmentShader: /* glsl */`
				uniform sampler2D tMap, tLower;
				uniform vec2 uTexel, uLowerSize;
				uniform float uRadius, uRim, uLower, uLowerFull;
				varying vec2 vUv;
				${cubicGLSL}
				void main() {
					vec3 sum = vec3( 0. );
					float total = 0.;
					for ( int i = 0; i < ${taps}; i ++ ) {
						float r = sqrt( ( float( i ) + .5 ) / ${taps}. );
						float a = float( i ) * 2.39996323;
						float w = 1. + uRim * ( r * r * r * r * 3. - .6 );
						sum += texture2D( tMap, vUv + vec2( cos( a ), sin( a ) ) * r * uRadius * uTexel ).rgb * w;
						total += w;
					}
					vec3 color = sum / total;
					if ( uLower > .5 ) color += uLowerFull > .5 ? texture2D( tLower, vUv ).rgb : ${upscale( 'tLower', 'uLowerSize' )};
					gl_FragColor = vec4( color, 1. );
				}
			`,
		} ) );

		// The sharp band plus everything below it, already added up; read directly when it is at full size.
		this.composite = new FullScreenQuad( new THREE.ShaderMaterial( {
			uniforms: {
				uBackground: { value: new THREE.Color() }, tSharp: { value: null },
				tLower: { value: null }, uLowerSize: { value: new THREE.Vector2( 1, 1 ) }, uLower: { value: 0 }, uLowerFull: { value: 1 },
			},
			vertexShader: quadVertex,
			fragmentShader: /* glsl */`
				uniform vec3 uBackground;
				uniform sampler2D tSharp, tLower;
				uniform vec2 uLowerSize;
				uniform float uLower, uLowerFull;
				varying vec2 vUv;
				${cubicGLSL}
				void main() {
					vec3 color = uBackground + texture2D( tSharp, vUv ).rgb;
					if ( uLower > .5 ) color += uLowerFull > .5 ? texture2D( tLower, vUv ).rgb : ${upscale( 'tLower', 'uLowerSize' )};
					gl_FragColor = vec4( color, 1. );
				}
			`,
		} ) );

		// Debug views: one band filling the frame, or every band in a grid read left to right, top to bottom.
		const names = this.bands.map( ( _, i ) => `tBand${i}` );
		const read = ( i, uv ) => cubic && this.bands[ i ].scale < 1 ? `cubic( ${names[ i ]}, ${uv}, uSize${i} )` : `texture2D( ${names[ i ]}, ${uv} ).rgb`;
		const columns = Math.ceil( Math.sqrt( this.bands.length ) ), rows = Math.ceil( this.bands.length / columns );
		this.inspect = new FullScreenQuad( new THREE.ShaderMaterial( {
			uniforms: {
				uGrid: { value: 0 }, uBand: { value: 0 }, uGain: { value: 1 },
				...Object.fromEntries( names.map( ( n ) => [ n, { value: null } ] ) ),
				...Object.fromEntries( names.map( ( _, i ) => [ `uSize${i}`, { value: new THREE.Vector2( 1, 1 ) } ] ) ),
			},
			vertexShader: quadVertex,
			fragmentShader: /* glsl */`
				uniform float uGrid, uGain;
				uniform int uBand;
				${names.map( ( n, i ) => `uniform sampler2D ${n};\nuniform vec2 uSize${i};` ).join( '\n' )}
				varying vec2 vUv;
				${cubicGLSL}
				vec3 band( int i, vec2 uv ) {
					${this.bands.map( ( _, i ) => `if ( i == ${i} ) return ${read( i, 'uv' )};` ).join( '\n' )}
					return vec3( 0. );
				}
				void main() {
					if ( uGrid < .5 ) {
						gl_FragColor = vec4( band( uBand, vUv ) * uGain, 1. );
						return;
					}
					vec2 cell = vUv * vec2( ${columns}., ${rows}. );
					vec2 at = floor( cell ), uv = fract( cell );
					int i = int( at.x ) + int( ${rows - 1}. - at.y ) * ${columns};
					vec3 color = band( i, uv ) * uGain;
					vec2 edge = min( uv, 1. - uv ) * uSize0 / vec2( ${columns}., ${rows}. );
					gl_FragColor = vec4( min( edge.x, edge.y ) < 1. ? vec3( .25 ) : color, 1. );
				}
			`,
		} ) );
		this.setSize( ...this.size );
	}

	// For a debug readout: each band's blur radius and the size of its target.
	get info() {
		return this.bands.map( ( { radius, scale, target } ) => ( { radius, scale, width: target.width, height: target.height } ) );
	}

	setSize( width, height ) {
		this.size = [ width, height ];
		for ( const band of this.bands ) {
			const w = Math.max( 1, Math.round( width * band.scale ) ), h = Math.max( 1, Math.round( height * band.scale ) );
			band.target.setSize( w, h );
			band.blurred?.setSize( w, h );
		}
	}

	// The largest blur radius any point inside `bounds` can have from where the camera is, in screen pixels:
	// blur grows away from the focal plane on both sides, so it peaks at the nearest or farthest point.
	maxBlur() {
		if ( ! this.bounds ) return Infinity;
		const { lens, camera } = this;
		const centre = this.bounds.center.clone().applyMatrix4( camera.matrixWorldInverse );
		const near = Math.max( - centre.z - this.bounds.radius, camera.near ), far = - centre.z + this.bounds.radius;
		const f = lens.uFocus.value, perPixel = camera.projectionMatrix.elements[ 5 ] * .25 * lens.uFullResolution.value.y / Math.max( f, 1 );
		return Math.max( ...[ near, far ].map( ( d ) => lens.uAperture.value * Math.abs( d - f ) / d * perPixel ) );
	}

	render( renderer, writeBuffer, readBuffer ) {
		const { scene, camera, lens, radii, debug, bands } = this;
		const background = scene.background;
		const autoClear = renderer.autoClear;
		const clearColor = renderer.getClearColor( new THREE.Color() ), clearAlpha = renderer.getClearAlpha();
		const resolution = lens.uResolution.value.clone();
		scene.background = null;
		renderer.autoClear = false;
		renderer.setClearColor( 0x000000, 0 );

		const inspecting = debug.view !== 'final';
		const reach = inspecting ? Infinity : this.maxBlur();
		const blur = this.blur.material.uniforms;
		let lower = null;

		// Blurriest first, so each blur pass can add up everything below it.
		for ( let i = bands.length - 1; i >= 0; i -- ) {
			const band = bands[ i ];
			if ( i > 0 && radii[ i - 1 ] >= reach ) continue;
			lens.uBand.value.set( radii[ i - 1 ] ?? 0, band.radius, radii[ i + 1 ] ?? band.radius );
			lens.uBandScale.value = band.scale;
			lens.uResolution.value.set( band.target.width, band.target.height );
			renderer.setRenderTarget( band.target );
			renderer.clear();
			renderer.render( scene, camera );
			if ( ! band.blurred ) continue;
			blur.tMap.value = band.target.texture;
			blur.uTexel.value.set( 1 / band.target.width, 1 / band.target.height );
			blur.uRadius.value = band.radius * band.scale;
			blur.uLower.value = ! inspecting && lower ? 1 : 0;
			if ( lower ) {
				blur.tLower.value = lower.texture;
				blur.uLowerSize.value.set( lower.width, lower.height );
				blur.uLowerFull.value = lower.width === band.target.width && lower.height === band.target.height ? 1 : 0;
			}
			renderer.setRenderTarget( band.blurred );
			this.blur.render( renderer );
			lower = band.blurred;
		}

		lens.uBand.value.set( 0, 0, 0 );
		lens.uBandScale.value = 1;
		lens.uResolution.value.copy( resolution );
		renderer.setRenderTarget( this.renderToScreen ? null : readBuffer );
		if ( inspecting ) {
			const u = this.inspect.material.uniforms;
			bands.forEach( ( band, i ) => {
				u[ `tBand${i}` ].value = ( debug.stage === 'sharp' ? band.target : band.blurred || band.target ).texture;
				u[ `uSize${i}` ].value.set( band.target.width, band.target.height );
			} );
			u.uGrid.value = debug.view === 'grid' ? 1 : 0;
			u.uBand.value = Math.min( debug.band, bands.length - 1 );
			u.uGain.value = debug.gain;
			this.inspect.render( renderer );
		} else {
			const u = this.composite.material.uniforms;
			u.uBackground.value.copy( background?.isColor ? background : new THREE.Color( 0 ) );
			u.tSharp.value = bands[ 0 ].target.texture;
			u.uLower.value = lower ? 1 : 0;
			if ( lower ) {
				u.tLower.value = lower.texture;
				u.uLowerSize.value.set( lower.width, lower.height );
				u.uLowerFull.value = lower.width === bands[ 0 ].target.width && lower.height === bands[ 0 ].target.height ? 1 : 0;
			}
			this.composite.render( renderer );
		}

		scene.background = background;
		renderer.autoClear = autoClear;
		renderer.setClearColor( clearColor, clearAlpha );
	}

	disposeBands() {
		for ( const band of this.bands ) {
			band.target.dispose();
			band.blurred?.dispose();
		}
		for ( const quad of [ this.blur, this.composite, this.inspect ] ) {
			quad?.material.dispose();
			quad?.dispose();
		}
	}

	dispose() {
		this.disposeBands();
	}
}
