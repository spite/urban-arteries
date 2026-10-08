import * as THREE from 'three';
import { stripGeometry, createStripMaterial } from './strips.js';
import { particleGeometry, createParticleMaterial } from './particles.js';
import { createMarker } from './marker.js';
import { targetGeometry, createTargetMaterial } from './targets.js';
import { createSharpLineMaterial, createSharpParticleMaterial, createSharpTargetMaterial } from './sharp.js';

// Draws a routed network (paths from graph/routes.js toPaths, or any { points, dist, weight } list) as either
// soft lines or particles, growing out from the origin and then pulsing, with optional dots at the destinations
// that fade as the routes reach them. Add `group` to a scene and call update() every frame; uniforms come from
// createUniforms() / the viewer. Each kind is built twice on one geometry: blurred by its own material on layer 1
// for the direct pipeline, and sharp on layer 2 for the layered one.
export function createArteries( uniforms ) {
	const group = new THREE.Group();
	const lineMaterial = createStripMaterial( uniforms );
	const particleMaterial = createParticleMaterial( uniforms );
	const targetMaterial = createTargetMaterial( uniforms );
	const sharp = {
		lines: createSharpLineMaterial( uniforms ),
		dust: createSharpParticleMaterial( uniforms ),
		dots: createSharpTargetMaterial( uniforms ),
	};
	const marker = createMarker( uniforms );
	marker.layers.enable( 1 );
	marker.layers.enable( 2 );
	group.add( marker );

	let lines = null, dust = null, dots = null, style = 'particles', showTargets = true;
	let layered = { lines: null, dust: null, dots: null };
	let growStart = 0, maxDist = 1;

	function applyStyle() {
		for ( const set of [ { lines, dust, dots }, layered ] ) {
			if ( set.lines ) set.lines.visible = style === 'lines';
			if ( set.dust ) set.dust.visible = style === 'particles';
			if ( set.dots ) set.dots.visible = showTargets;
		}
	}

	function clear() {
		for ( const m of [ lines, dust, dots ] ) {
			if ( ! m ) continue;
			group.remove( m );
			m.geometry.dispose();
		}
		for ( const m of Object.values( layered ) ) if ( m ) group.remove( m );
		lines = dust = dots = null;
		layered = { lines: null, dust: null, dots: null };
	}

	// The layered twin of a direct mesh: same geometry, sharp material, on layer 2.
	function twin( mesh, material ) {
		const copy = new mesh.constructor( mesh.geometry, material );
		copy.frustumCulled = false;
		copy.layers.set( 2 );
		group.add( copy );
		return copy;
	}

	return {
		group,
		// radius sets the detail: lines are split every radius/150, particles spaced radius/320.
		// maxDist is the longest path distance, where growth ends. targets: [ { point, dist } ] (routes.js toTargets).
		set( paths, { radius, maxDist: longest, targets = [] } ) {
			clear();
			lines = new THREE.Mesh( stripGeometry( paths, { step: radius / 150 } ), lineMaterial );
			dust = new THREE.Points( particleGeometry( paths, { spacing: radius / 320 } ), particleMaterial );
			dots = new THREE.Points( targetGeometry( targets ), targetMaterial );
			targetMaterial.uniforms.uFade.value = sharp.dots.uniforms.uFade.value = Math.max( longest * .15, 1 );
			for ( const m of [ lines, dust, dots ] ) {
				m.frustumCulled = false;
				m.layers.set( 1 );
				group.add( m );
			}
			layered = { lines: twin( lines, sharp.lines ), dust: twin( dust, sharp.dust ), dots: twin( dots, sharp.dots ) };
			applyStyle();
			maxDist = longest;
		},
		setStyle( value ) {
			style = value;
			applyStyle();
		},
		setTargetsVisible( value ) {
			showTargets = value;
			applyStyle();
		},
		replay() {
			growStart = performance.now();
		},
		// grow: seconds for the network to grow out; pulse: run a wave out along it every few seconds afterwards.
		update( now, { grow = 5, pulse = true } = {} ) {
			const t = Math.max( now - growStart, 0 ) / 1000;
			const k = Math.min( t / grow, 1 );
			uniforms.uGrow.value = ( 1 - ( 1 - k ) ** 3 ) * ( maxDist + 1 );
			const cycle = 6, after = t - grow - 1;
			uniforms.uPulse.value = pulse && after > 0 && after % cycle < cycle * .7 ? ( after % cycle ) / ( cycle * .7 ) * maxDist : - 1;
			marker.material.uniforms.uTime.value = now / 1000;
		},
		dispose() {
			clear();
			marker.geometry.dispose();
			for ( const m of [ lineMaterial, particleMaterial, targetMaterial, marker.material, ...Object.values( sharp ) ] ) m.dispose();
		},
	};
}
