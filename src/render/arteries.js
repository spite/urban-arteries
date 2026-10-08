import * as THREE from 'three';
import { stripGeometry, createStripMaterial } from './strips.js';
import { particleGeometry, createParticleMaterial } from './particles.js';
import { createMarker } from './marker.js';

// Draws a routed network (paths from graph/routes.js toPaths, or any { points, dist, weight } list) as either
// soft lines or particles, growing out from the origin and then pulsing. Add `group` to a scene and call
// update() every frame; uniforms come from createUniforms() / the viewer.
export function createArteries( uniforms ) {
	const group = new THREE.Group();
	const lineMaterial = createStripMaterial( uniforms );
	const particleMaterial = createParticleMaterial( uniforms );
	const marker = createMarker( uniforms );
	group.add( marker );

	let lines = null, dust = null, style = 'particles';
	let growStart = 0, maxDist = 1;

	function applyStyle() {
		if ( lines ) lines.visible = style === 'lines';
		if ( dust ) dust.visible = style === 'particles';
	}

	function clear() {
		for ( const m of [ lines, dust ] ) {
			if ( ! m ) continue;
			group.remove( m );
			m.geometry.dispose();
		}
		lines = dust = null;
	}

	return {
		group,
		// radius sets the detail: lines are split every radius/150, particles spaced radius/320.
		// maxDist is the longest path distance, where growth ends.
		set( paths, { radius, maxDist: longest } ) {
			clear();
			lines = new THREE.Mesh( stripGeometry( paths, { step: radius / 150 } ), lineMaterial );
			dust = new THREE.Points( particleGeometry( paths, { spacing: radius / 320 } ), particleMaterial );
			for ( const m of [ lines, dust ] ) {
				m.frustumCulled = false;
				group.add( m );
			}
			applyStyle();
			maxDist = longest;
		},
		setStyle( value ) {
			style = value;
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
			for ( const m of [ lineMaterial, particleMaterial, marker.material ] ) m.dispose();
		},
	};
}
