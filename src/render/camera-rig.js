import * as THREE from 'three';

// Camera moves for a perspective camera orbiting with OrbitControls around a ground-level subject (y up).
export function createCameraRig( camera, controls ) {
	// Moves the camera to `distance` from the target at `tilt` degrees above the ground, keeping its bearing.
	function place( distance, tilt ) {
		const offset = camera.position.clone().sub( controls.target );
		const bearing = Math.atan2( offset.x, offset.z );
		const up = THREE.MathUtils.degToRad( tilt );
		camera.position.copy( controls.target ).add( new THREE.Vector3(
			Math.sin( bearing ) * Math.cos( up ), Math.sin( up ), Math.cos( bearing ) * Math.cos( up ) ).multiplyScalar( distance ) );
		controls.update();
	}

	const distance = () => camera.position.distanceTo( controls.target );

	return {
		place,
		// Looks at the origin from the south, at tilt degrees, from the closest distance where the whole rim of a
		// disc of `radius` stays inside the view, perspective included.
		frame( radius, { tilt = 24, margin = .92 } = {} ) {
			controls.target.set( 0, 0, 0 );
			camera.position.set( 0, 0, 1 );
			const rim = Array.from( { length: 48 }, ( _, i ) => new THREE.Vector3( Math.cos( i / 48 * Math.PI * 2 ) * radius, 0, Math.sin( i / 48 * Math.PI * 2 ) * radius ) );
			const fits = ( d ) => {
				place( d, tilt );
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
			const d = distance();
			const scale = Math.tan( THREE.MathUtils.degToRad( camera.fov / 2 ) ) / Math.tan( THREE.MathUtils.degToRad( value / 2 ) );
			camera.fov = value;
			camera.updateProjectionMatrix();
			if ( d > 1e-6 ) place( d * scale, 90 - THREE.MathUtils.radToDeg( Math.acos( ( camera.position.y - controls.target.y ) / d ) ) );
		},
		setTilt( tilt ) {
			const d = distance();
			if ( d > 1e-6 ) place( d, tilt );
		},
	};
}

// The vertical field of view of a lens of `mm` focal length on a 35 mm (24 mm tall) frame, in degrees.
export const fovOf = ( mm ) => 2 * Math.atan( 12 / mm ) * 180 / Math.PI;
