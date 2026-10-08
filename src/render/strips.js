import * as THREE from 'three';
import { defocusGLSL, arteryColorGLSL } from './chunks.js';

// Screen-space lines in the MeshLine style, for paths: { points: [ [ x, y, z ] ], dist: [], weight: [] }.
// Every point is emitted twice (one per side) with its neighbours, plus a cap slot at both ends so the
// Gaussian profile also fades lengthwise. Segments longer than `step` are split, because the defocus is only
// evaluated per vertex and a long segment must be able to narrow where it crosses the focal plane.
export function stripGeometry( paths, { step = Infinity } = {} ) {
	const lines = paths.map( ( { points, dist, weight } ) => {
		const pts = [];
		points.forEach( ( p, i ) => {
			if ( i > 0 ) {
				const q = points[ i - 1 ];
				const parts = Math.ceil( Math.hypot( p[ 0 ] - q[ 0 ], p[ 1 ] - q[ 1 ], p[ 2 ] - q[ 2 ] ) / step );
				for ( let k = 1; k < parts; k ++ ) {
					const t = k / parts;
					pts.push( { p: q.map( ( c, j ) => c + ( p[ j ] - c ) * t ), d: dist[ i - 1 ] + ( dist[ i ] - dist[ i - 1 ] ) * t, w: weight[ i ] } );
				}
			}
			pts.push( { p, d: dist[ i ], w: weight[ i ] } );
		} );
		return pts;
	} ).filter( ( pts ) => pts.length > 1 );

	let slots = 0, quads = 0;
	for ( const pts of lines ) { slots += pts.length + 2; quads += pts.length + 1; }
	const position = new Float32Array( slots * 6 ), prev = new Float32Array( slots * 6 ), next = new Float32Array( slots * 6 );
	const side = new Float32Array( slots * 2 ), cap = new Float32Array( slots * 2 );
	const aDist = new Float32Array( slots * 2 ), aW = new Float32Array( slots * 2 );
	const index = new Uint32Array( quads * 6 );
	const put = ( array, slot, p ) => {
		array.set( p, slot * 6 );
		array.set( p, slot * 6 + 3 );
	};
	let slot = 0, q = 0;
	for ( const pts of lines ) {
		const n = pts.length, first = slot;
		for ( let k = - 1; k <= n; k ++, slot ++ ) {
			const i = Math.min( Math.max( k, 0 ), n - 1 );
			put( position, slot, pts[ i ].p );
			put( prev, slot, pts[ k === n ? n - 2 : Math.max( i - 1, 0 ) ].p );
			put( next, slot, pts[ k === - 1 ? 1 : Math.min( i + 1, n - 1 ) ].p );
			const c = k === - 1 ? - 1 : k === n ? 1 : 0;
			side.set( [ - 1, 1 ], slot * 2 );
			cap.set( [ c, c ], slot * 2 );
			aDist.set( [ pts[ i ].d, pts[ i ].d ], slot * 2 );
			aW.set( [ pts[ i ].w, pts[ i ].w ], slot * 2 );
		}
		for ( let k = first; k < slot - 1; k ++, q ++ ) {
			const a = k * 2;
			index.set( [ a, a + 1, a + 2, a + 1, a + 3, a + 2 ], q * 6 );
		}
	}
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( position, 3 ) );
	geometry.setAttribute( 'prev', new THREE.BufferAttribute( prev, 3 ) );
	geometry.setAttribute( 'next', new THREE.BufferAttribute( next, 3 ) );
	geometry.setAttribute( 'side', new THREE.BufferAttribute( side, 1 ) );
	geometry.setAttribute( 'cap', new THREE.BufferAttribute( cap, 1 ) );
	geometry.setAttribute( 'aDist', new THREE.BufferAttribute( aDist, 1 ) );
	geometry.setAttribute( 'aW', new THREE.BufferAttribute( aW, 1 ) );
	geometry.setIndex( new THREE.BufferAttribute( index, 1 ) );
	return geometry;
}

// Strips 3 sigma wide on each side of a Gaussian cross-section. Blended with max rather than added, so a branch
// starting on its trunk doesn't leave a bright bead. Uniforms come from createUniforms().
export function createStripMaterial( uniforms ) {
	return new THREE.ShaderMaterial( {
		uniforms,
		transparent: true,
		depthWrite: false,
		side: THREE.DoubleSide,
		blending: THREE.CustomBlending,
		blendEquation: THREE.MaxEquation,
		vertexShader: /* glsl */`
			uniform float uExag;
			${defocusGLSL}
			attribute vec3 prev, next;
			attribute float side, cap, aDist, aW;
			varying float vSide, vCap, vW, vDist, vEnergy;

			vec2 screen( vec3 p ) {
				vec4 c = projectionMatrix * modelViewMatrix * vec4( p * vec3( 1., uExag, 1. ), 1. );
				return c.xy / c.w * .5 * uResolution;
			}

			void main() {
				vec4 mv = modelViewMatrix * vec4( position * vec3( 1., uExag, 1. ), 1. );
				vec4 c = projectionMatrix * mv;
				vec2 s = c.xy / c.w * .5 * uResolution;
				vec2 d1 = s - screen( prev ), d2 = screen( next ) - s;
				if ( dot( d1, d1 ) < 1e-6 ) d1 = d2;
				if ( dot( d2, d2 ) < 1e-6 ) d2 = d1;
				d1 = dot( d1, d1 ) > 1e-12 ? normalize( d1 ) : vec2( 1., 0. );
				d2 = dot( d2, d2 ) > 1e-12 ? normalize( d2 ) : d1;
				vec2 tangent = d1 + d2;
				tangent = dot( tangent, tangent ) > 1e-6 ? normalize( tangent ) : d1;
				vec2 normal = vec2( - tangent.y, tangent.x );

				float stroke = 1.2 + 12. * aW;
				float sigma = min( defocusSigma( stroke, - mv.z ), 133. );
				float hw = 3. * sigma;
				vec2 offset = normal * side * hw + tangent * cap * hw;
				c.xy += offset / ( .5 * uResolution ) * c.w;
				gl_Position = c;

				// A line spreads only across itself, so its peak falls with sigma, not sigma squared.
				vEnergy = strokeSigma( stroke ) / sigma;
				vSide = side;
				vCap = cap;
				vW = aW;
				vDist = aDist;
			}
		`,
		fragmentShader: /* glsl */`
			${arteryColorGLSL}
			varying float vSide, vCap, vW, vDist, vEnergy;

			void main() {
				if ( vDist > uGrow ) discard;
				float g = exp( - ( vSide * vSide + vCap * vCap ) * 4.5 ) * vEnergy;
				gl_FragColor = vec4( arteryColor( vW, vDist, .35, .9 ) * g, 1. );
			}
		`,
	} );
}
