import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createLensUniforms } from '../lens/uniforms.js';
import { createCameraRig } from './camera-rig.js';
import { createPost } from './post.js';

// A view that fills `container`: renderer, scene, camera with orbit controls, and the frame pipeline from post.js.
// Draw into it with lens materials (lens/material.js) sharing `lens`; render() keeps the lens focused on the orbit
// target. preserveDrawingBuffer keeps the last frame readable, so the canvas can be saved or captured any time.
export function createViewer( container, { fov = 50, far = 200000, background = 0x05060a, preserveDrawingBuffer = true } = {} ) {
	const renderer = new THREE.WebGLRenderer( { antialias: false, preserveDrawingBuffer } );
	const fullRatio = Math.min( devicePixelRatio, 2 );
	renderer.setPixelRatio( fullRatio );
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	container.appendChild( renderer.domElement );

	// As scene.background rather than a clear colour: three converts a clear colour for the target active when it
	// is set (the screen), so an HDR target would be cleared with sRGB values and tone-mapped twice.
	const scene = new THREE.Scene();
	scene.background = new THREE.Color( background );
	const camera = new THREE.PerspectiveCamera( fov, 1, 1, far );
	const controls = new OrbitControls( camera, renderer.domElement );
	controls.enableDamping = true;
	controls.autoRotateSpeed = .35;
	controls.maxPolarAngle = Math.PI * .49;

	const lens = createLensUniforms( { pixelRatio: fullRatio } );
	const rig = createCameraRig( camera, controls );
	const post = createPost( renderer, scene, camera, lens );

	function resize() {
		const w = container.clientWidth || innerWidth, h = container.clientHeight || innerHeight;
		renderer.setSize( w, h );
		post.setSize( w, h );
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		renderer.getDrawingBufferSize( lens.uResolution.value );
		lens.uFullResolution.value.copy( lens.uResolution.value );
	}
	resize();
	addEventListener( 'resize', resize );

	return {
		renderer, scene, camera, controls, lens,
		frame: rig.frame,
		setFov: rig.setFov,
		setTilt: rig.setTilt,
		setLook: post.setLook,
		setBands: post.setBands,
		setDebug: post.setDebug,
		setBounds: post.setBounds,
		get bands() {
			return post.bands;
		},
		// Renders at `scale` of the full pixel ratio; strokes and blur are sized in device pixels, so the picture
		// keeps its proportions and only gets softer.
		setScale( scale ) {
			const ratio = fullRatio * scale;
			if ( Math.abs( ratio - renderer.getPixelRatio() ) < 1e-3 ) return;
			renderer.setPixelRatio( ratio );
			post.setPixelRatio( ratio );
			lens.uPixelRatio.value = ratio;
			resize();
		},
		setBackground( color ) {
			scene.background.set( color );
		},
		render() {
			controls.update();
			lens.uFocus.value = camera.position.distanceTo( controls.target );
			post.render();
		},
		dispose() {
			removeEventListener( 'resize', resize );
			controls.dispose();
			post.dispose();
			renderer.dispose();
			renderer.domElement.remove();
		},
	};
}
