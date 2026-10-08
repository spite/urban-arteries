import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createUniforms } from './chunks.js';

// A full-window WebGL view with orbit controls, holding the uniforms the materials in this folder share.
// render() keeps the lens focused on the orbit target and the resolution uniform in step with the canvas.
// preserveDrawingBuffer keeps the last frame readable, so the canvas can be saved or captured at any time.
export function createViewer( container, { fov = 50, far = 50000, background = 0x05060a, preserveDrawingBuffer = true } = {} ) {
	const renderer = new THREE.WebGLRenderer( { antialias: true, preserveDrawingBuffer } );
	renderer.setPixelRatio( Math.min( devicePixelRatio, 2 ) );
	renderer.setClearColor( background );
	container.appendChild( renderer.domElement );

	const scene = new THREE.Scene();
	const camera = new THREE.PerspectiveCamera( fov, 1, 1, far );
	const controls = new OrbitControls( camera, renderer.domElement );
	controls.enableDamping = true;
	controls.autoRotateSpeed = .35;
	controls.maxPolarAngle = Math.PI * .49;

	const uniforms = createUniforms( { pixelRatio: renderer.getPixelRatio() } );

	function resize() {
		const w = container.clientWidth || innerWidth, h = container.clientHeight || innerHeight;
		renderer.setSize( w, h );
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		renderer.getDrawingBufferSize( uniforms.uResolution.value );
	}
	resize();
	addEventListener( 'resize', resize );

	return {
		renderer, scene, camera, controls, uniforms,
		// Looks at the origin from above and to the south, far enough to take in `radius`.
		frame( radius ) {
			camera.position.set( 0, radius * .95, radius * 2.1 );
			controls.target.set( 0, 0, 0 );
			controls.update();
		},
		render() {
			controls.update();
			uniforms.uFocus.value = camera.position.distanceTo( controls.target );
			renderer.render( scene, camera );
		},
	};
}
