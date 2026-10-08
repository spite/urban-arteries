import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// Layered depth of field, as an EffectComposer pass in place of a RenderPass. The scene is drawn sharp once per
// blur band (materials from sharp.js put each stroke's light into the bands either side of its blur radius), each
// band is blurred by the aperture disc, and the bands are added up. A band is rendered at a resolution where its
// blur is only BAND_TEXELS wide, so the cost hardly depends on how blurred or how dense the scene is. Everything
// drawn is light that adds up with nothing hiding anything else, so adding the bands back together is exact.

export const BAND_RADII = [ 0, 2, 4, 8, 16, 32, 64, 128, 256 ];
const BAND_TEXELS = 3;
const TAPS = 48;

const quadVertex = /* glsl */`
	varying vec2 vUv;
	void main() {
		vUv = uv;
		gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1. );
	}
`;

export class LayeredPass extends Pass {
	// uniforms: the shared uniforms from createUniforms(); this pass drives uBin, uBinScale and uResolution.
	constructor( scene, camera, uniforms, { radii = BAND_RADII } = {} ) {
		super();
		this.needsSwap = false;
		this.scene = scene;
		this.camera = camera;
		this.uniforms = uniforms;
		this.radii = radii;
		const options = { type: THREE.HalfFloatType, depthBuffer: false };
		this.bands = radii.map( ( radius ) => ( {
			radius,
			scale: radius > 0 ? Math.min( 1, BAND_TEXELS / radius ) : 1,
			target: new THREE.WebGLRenderTarget( 1, 1, options ),
			blurred: radius > 0 ? new THREE.WebGLRenderTarget( 1, 1, options ) : null,
		} ) );

		// The aperture disc as a Vogel spiral of taps, weighted toward the rim by uRim like the direct pipeline.
		this.blur = new FullScreenQuad( new THREE.ShaderMaterial( {
			uniforms: { tMap: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1 }, uRim: uniforms.uRim },
			vertexShader: quadVertex,
			fragmentShader: /* glsl */`
				uniform sampler2D tMap;
				uniform vec2 uTexel;
				uniform float uRadius, uRim;
				varying vec2 vUv;
				void main() {
					vec3 sum = vec3( 0. );
					float total = 0.;
					for ( int i = 0; i < ${TAPS}; i ++ ) {
						float r = sqrt( ( float( i ) + .5 ) / ${TAPS}. );
						float a = float( i ) * 2.39996323;
						float w = 1. + uRim * ( r * r * r * r * 3. - .6 );
						sum += texture2D( tMap, vUv + vec2( cos( a ), sin( a ) ) * r * uRadius * uTexel ).rgb * w;
						total += w;
					}
					gl_FragColor = vec4( sum / total, 1. );
				}
			`,
		} ) );

		// Bands below full resolution are upscaled with a cubic B-spline (four bilinear taps) rather than plain
		// bilinear, which would leave a faint box pattern in their smooth gradients.
		const names = this.bands.map( ( _, i ) => `tBand${i}` );
		const read = ( band, i ) => band.scale < 1 ? `cubic( ${names[ i ]}, vUv, uSize${i} )` : `texture2D( ${names[ i ]}, vUv ).rgb`;
		this.composite = new FullScreenQuad( new THREE.ShaderMaterial( {
			uniforms: {
				uBackground: { value: new THREE.Color() },
				...Object.fromEntries( names.map( ( n ) => [ n, { value: null } ] ) ),
				...Object.fromEntries( names.map( ( _, i ) => [ `uSize${i}`, { value: new THREE.Vector2( 1, 1 ) } ] ) ),
			},
			vertexShader: quadVertex,
			fragmentShader: /* glsl */`
				uniform vec3 uBackground;
				${names.map( ( n, i ) => `uniform sampler2D ${n};\nuniform vec2 uSize${i};` ).join( '\n' )}
				varying vec2 vUv;

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

				void main() {
					gl_FragColor = vec4( uBackground + ${this.bands.map( read ).join( ' + ' )}, 1. );
				}
			`,
		} ) );
	}

	setSize( width, height ) {
		for ( const band of this.bands ) {
			const w = Math.max( 1, Math.round( width * band.scale ) ), h = Math.max( 1, Math.round( height * band.scale ) );
			band.target.setSize( w, h );
			band.blurred?.setSize( w, h );
		}
	}

	render( renderer, writeBuffer, readBuffer ) {
		const { scene, camera, uniforms, radii } = this;
		const background = scene.background;
		const autoClear = renderer.autoClear;
		const clearColor = renderer.getClearColor( new THREE.Color() ), clearAlpha = renderer.getClearAlpha();
		const resolution = uniforms.uResolution.value.clone();
		scene.background = null;
		renderer.autoClear = false;
		renderer.setClearColor( 0x000000, 0 );

		this.bands.forEach( ( band, i ) => {
			uniforms.uBin.value.set( radii[ i - 1 ] ?? 0, band.radius, radii[ i + 1 ] ?? band.radius );
			uniforms.uBinScale.value = band.scale;
			uniforms.uResolution.value.set( band.target.width, band.target.height );
			renderer.setRenderTarget( band.target );
			renderer.clear();
			renderer.render( scene, camera );
			if ( band.blurred ) {
				const u = this.blur.material.uniforms;
				u.tMap.value = band.target.texture;
				u.uTexel.value.set( 1 / band.target.width, 1 / band.target.height );
				u.uRadius.value = band.radius * band.scale;
				renderer.setRenderTarget( band.blurred );
				this.blur.render( renderer );
			}
			this.composite.material.uniforms[ `tBand${i}` ].value = ( band.blurred || band.target ).texture;
			this.composite.material.uniforms[ `uSize${i}` ].value.set( band.target.width, band.target.height );
		} );

		uniforms.uBin.value.set( 0, 0, 0 );
		uniforms.uBinScale.value = 1;
		uniforms.uResolution.value.copy( resolution );
		this.composite.material.uniforms.uBackground.value.copy( background?.isColor ? background : new THREE.Color( 0 ) );
		renderer.setRenderTarget( this.renderToScreen ? null : readBuffer );
		this.composite.render( renderer );

		scene.background = background;
		renderer.autoClear = autoClear;
		renderer.setClearColor( clearColor, clearAlpha );
	}

	dispose() {
		for ( const band of this.bands ) {
			band.target.dispose();
			band.blurred?.dispose();
		}
		this.blur.dispose();
		this.composite.dispose();
	}
}
