import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { createUniforms } from './chunks.js';
import { LayeredPass } from './layered.js';

// A full-window view with orbit controls, holding the uniforms the materials in this folder share. The scene is
// rendered as light into a half-float target, bloomed, then ACES tone-mapped, so overlapping blur adds up and
// highlights roll off instead of clipping. render() keeps the lens focused on the orbit target.
// Two pipelines draw the depth of field: 'layered' (layered.js, objects on layer 2) and 'direct', where each
// material blurs itself analytically (objects on layer 1). setPipeline() switches between them.
// preserveDrawingBuffer keeps the last frame readable, so the canvas can be saved or captured at any time.
export function createViewer( container, { fov = 50, far = 200000, background = 0x05060a, preserveDrawingBuffer = true } = {} ) {
	const renderer = new THREE.WebGLRenderer( { antialias: false, preserveDrawingBuffer } );
	const fullRatio = Math.min( devicePixelRatio, 2 );
	renderer.setPixelRatio( fullRatio );
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	container.appendChild( renderer.domElement );

	// As scene.background rather than a clear colour: three converts a clear colour for the target active when it
	// is set (the screen), so the HDR target would be cleared with sRGB values and tone-mapped twice.
	const scene = new THREE.Scene();
	scene.background = new THREE.Color( background );
	const camera = new THREE.PerspectiveCamera( fov, 1, 1, far );
	const controls = new OrbitControls( camera, renderer.domElement );
	controls.enableDamping = true;
	controls.autoRotateSpeed = .35;
	controls.maxPolarAngle = Math.PI * .49;

	const uniforms = createUniforms( { pixelRatio: renderer.getPixelRatio() } );

	const composer = new EffectComposer( renderer );
	const direct = new RenderPass( scene, camera );
	const layered = new LayeredPass( scene, camera, uniforms );
	composer.addPass( direct );
	composer.addPass( layered );
	const bloom = new UnrealBloomPass( new THREE.Vector2( 1, 1 ), .3, 0, 1 );
	// Weighted toward the tight levels: the widest would smear the whole city's light into a haze over the frame.
	bloom.compositeMaterial.uniforms.bloomFactors.value = [ 1, .5, .2, .05, 0 ];
	composer.addPass( bloom );
	composer.addPass( new OutputPass() );

	// Film grain on the finished image: triangular noise, fresh every frame, lighter in the blacks than the mid-tones.
	const grain = new ShaderPass( {
		uniforms: { tDiffuse: { value: null }, uGrain: { value: 0 }, uSeed: { value: 0 } },
		vertexShader: /* glsl */`
			varying vec2 vUv;
			void main() {
				vUv = uv;
				gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1. );
			}
		`,
		fragmentShader: /* glsl */`
			uniform sampler2D tDiffuse;
			uniform float uGrain, uSeed;
			varying vec2 vUv;
			float hash( vec2 p ) {
				vec3 q = fract( vec3( p.xyx ) * .1031 );
				q += dot( q, q.yzx + 33.33 );
				return fract( ( q.x + q.y ) * q.z );
			}
			void main() {
				vec4 c = texture2D( tDiffuse, vUv );
				vec2 p = gl_FragCoord.xy + uSeed * 117.;
				float n = hash( p ) + hash( p + 41.7 ) - 1.;
				float lum = dot( c.rgb, vec3( .2126, .7152, .0722 ) );
				gl_FragColor = vec4( c.rgb + n * uGrain * mix( .35, 1., smoothstep( 0., .5, lum ) ), 1. );
			}
		`,
	} );
	composer.addPass( grain );

	function resize() {
		const w = container.clientWidth || innerWidth, h = container.clientHeight || innerHeight;
		renderer.setSize( w, h );
		composer.setSize( w, h );
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		renderer.getDrawingBufferSize( uniforms.uResolution.value );
		uniforms.uFullResolution.value.copy( uniforms.uResolution.value );
	}
	resize();
	addEventListener( 'resize', resize );
	layered.enabled = false;
	camera.layers.set( 1 );

	// Moves the camera to `distance` from the target at `tilt` degrees above the ground, keeping its bearing.
	function place( distance, tilt ) {
		const offset = camera.position.clone().sub( controls.target );
		const bearing = Math.atan2( offset.x, offset.z );
		const up = THREE.MathUtils.degToRad( tilt );
		camera.position.copy( controls.target ).add( new THREE.Vector3(
			Math.sin( bearing ) * Math.cos( up ), Math.sin( up ), Math.cos( bearing ) * Math.cos( up ) ).multiplyScalar( distance ) );
		controls.update();
	}

	return {
		renderer, scene, camera, controls, uniforms,
		// Looks at the origin from the south, at tilt degrees, from the closest distance where the whole rim of a
		// disc of `radius` stays inside the view, perspective included.
		frame( radius, { tilt = 24, margin = .92 } = {} ) {
			controls.target.set( 0, 0, 0 );
			camera.position.set( 0, 0, 1 );
			const rim = Array.from( { length: 48 }, ( _, i ) => new THREE.Vector3( Math.cos( i / 48 * Math.PI * 2 ) * radius, 0, Math.sin( i / 48 * Math.PI * 2 ) * radius ) );
			const fits = ( distance ) => {
				place( distance, tilt );
				camera.updateMatrixWorld();
				return rim.every( ( p ) => {
					const q = p.clone().applyMatrix4( camera.matrixWorldInverse );
					if ( q.z > - camera.near ) return false;
					q.applyMatrix4( camera.projectionMatrix );
					return Math.abs( q.x ) <= margin && Math.abs( q.y ) <= margin;
				} );
			};
			let near = radius * .1, far = radius * 100;
			for ( let i = 0; i < 40; i ++ ) {
				const mid = Math.sqrt( near * far );
				if ( fits( mid ) ) far = mid; else near = mid;
			}
			place( far, tilt );
		},
		// Changes the field of view and dollies to keep the subject the same size, as swapping lenses would.
		setFov( value ) {
			const distance = camera.position.distanceTo( controls.target );
			if ( distance < 1e-6 ) {
				camera.fov = value;
				camera.updateProjectionMatrix();
				return;
			}
			const scale = Math.tan( THREE.MathUtils.degToRad( camera.fov / 2 ) ) / Math.tan( THREE.MathUtils.degToRad( value / 2 ) );
			camera.fov = value;
			camera.updateProjectionMatrix();
			place( distance * scale, 90 - THREE.MathUtils.radToDeg( Math.acos( ( camera.position.y - controls.target.y ) / distance ) ) );
		},
		setTilt( tilt ) {
			const distance = camera.position.distanceTo( controls.target );
			if ( distance > 1e-6 ) place( distance, tilt );
		},
		// Renders at `scale` of the full pixel ratio; strokes and blur are sized in device pixels, so the picture
		// keeps its proportions and only gets softer.
		setScale( scale ) {
			const ratio = fullRatio * scale;
			if ( Math.abs( ratio - renderer.getPixelRatio() ) < 1e-3 ) return;
			renderer.setPixelRatio( ratio );
			composer.setPixelRatio( ratio );
			uniforms.uPixelRatio.value = ratio;
			resize();
		},
		setPipeline( mode ) {
			direct.enabled = mode === 'direct';
			layered.enabled = mode === 'layered';
			camera.layers.set( mode === 'layered' ? 2 : 1 );
		},
		setBackground( color ) {
			scene.background.set( color );
		},
		setLook( { exposure = 1, bloom: strength = .3, grain: amount = 0 } = {} ) {
			renderer.toneMappingExposure = exposure;
			bloom.strength = strength;
			grain.uniforms.uGrain.value = amount;
			grain.enabled = amount > 0;
		},
		render() {
			controls.update();
			uniforms.uFocus.value = camera.position.distanceTo( controls.target );
			grain.uniforms.uSeed.value = Math.random();
			composer.render();
		},
	};
}
