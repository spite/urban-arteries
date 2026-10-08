import * as THREE from 'three';
import { defocusGLSL, arteryColorGLSL, profileGLSL } from './chunks.js';

// Lines for paths ({ points: [ [ x, y, z ] ], dist: [], weight: [] }) as one screen-space quad per segment. Lens
// blur is linear, so a blurred path is the sum of its blurred segments: each draws the stroke × aperture profile
// across itself and the exact falloff at its free ends. Where a path bends, both neighbours are clipped at the
// bisector instead, so nothing folds over or adds up twice — unless the blur is wide next to the segments, where
// bisectors of neighbouring joints would cross; there both sides fall back to blurred intervals, which sum
// smoothly. Segments longer than `step` are split, since the blur is only evaluated at segment ends.
export function stripGeometry( paths, { step = Infinity } = {} ) {
	const segs = [];
	for ( const { points, dist, weight } of paths ) {
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
		const n = pts.length;
		for ( let j = 0; j < n - 1; j ++ ) {
			segs.push( {
				a: pts[ j ], b: pts[ j + 1 ],
				prev: pts[ Math.max( j - 1, 0 ) ].p, next: pts[ Math.min( j + 2, n - 1 ) ].p,
				join: [ j > 0 ? 1 : 0, j + 2 < n ? 1 : 0 ],
			} );
		}
	}

	const count = segs.length;
	const aStart = new Float32Array( count * 3 ), aEnd = new Float32Array( count * 3 );
	const aPrev = new Float32Array( count * 3 ), aNext = new Float32Array( count * 3 );
	const aJoin = new Float32Array( count * 2 ), aDist = new Float32Array( count * 2 ), aW = new Float32Array( count );
	segs.forEach( ( { a, b, prev, next, join }, i ) => {
		aStart.set( a.p, i * 3 );
		aEnd.set( b.p, i * 3 );
		aPrev.set( prev, i * 3 );
		aNext.set( next, i * 3 );
		aJoin.set( join, i * 2 );
		aDist.set( [ a.d, b.d ], i * 2 );
		aW[ i ] = b.w;
	} );

	const geometry = new THREE.InstancedBufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( [ 0, - 1, 0, 1, - 1, 0, 1, 1, 0, 0, 1, 0 ], 3 ) );
	geometry.setIndex( [ 0, 1, 2, 0, 2, 3 ] );
	geometry.setAttribute( 'aStart', new THREE.InstancedBufferAttribute( aStart, 3 ) );
	geometry.setAttribute( 'aEnd', new THREE.InstancedBufferAttribute( aEnd, 3 ) );
	geometry.setAttribute( 'aPrev', new THREE.InstancedBufferAttribute( aPrev, 3 ) );
	geometry.setAttribute( 'aNext', new THREE.InstancedBufferAttribute( aNext, 3 ) );
	geometry.setAttribute( 'aJoin', new THREE.InstancedBufferAttribute( aJoin, 2 ) );
	geometry.setAttribute( 'aDist', new THREE.InstancedBufferAttribute( aDist, 2 ) );
	geometry.setAttribute( 'aW', new THREE.InstancedBufferAttribute( aW, 1 ) );
	geometry.instanceCount = count;
	return geometry;
}

// Lines drawn as light: overlapping lines add, so this is meant for an HDR target with tone mapping after it.
// Uniforms come from createUniforms().
export function createStripMaterial( uniforms ) {
	return new THREE.ShaderMaterial( {
		uniforms,
		transparent: true,
		depthWrite: false,
		depthTest: false,
		blending: THREE.AdditiveBlending,
		vertexShader: /* glsl */`
			uniform float uExag;
			${defocusGLSL}
			attribute vec3 aStart, aEnd, aPrev, aNext;
			attribute vec2 aJoin, aDist;
			attribute float aW;
			// vLocal: pixels along the segment from its start, and across from its axis. vClip: signed pixels inside
			// the bisectors at a joined start and end. All vary linearly in screen space, hence w = 1 below.
			varying vec2 vLocal, vClip, vJoin, vDist;
			varying float vLength, vStroke, vW;
			varying vec3 vBlur;

			vec4 view( vec3 p ) { return modelViewMatrix * vec4( p * vec3( 1., uExag, 1. ), 1. ); }

			void main() {
				vec4 m0 = view( aStart ), m1 = view( aEnd );
				vec4 c0 = projectionMatrix * m0, c1 = projectionMatrix * m1;
				if ( c0.w <= 0. || c1.w <= 0. ) { gl_Position = vec4( 2., 2., 2., 1. ); return; }
				vec2 hs = .5 * uResolution;
				vec2 s0 = c0.xy / c0.w * hs, s1 = c1.xy / c1.w * hs;
				vec4 cp = projectionMatrix * view( aPrev ), cn = projectionMatrix * view( aNext );
				vec2 sp = cp.xy / max( cp.w, 1e-6 ) * hs, sn = cn.xy / max( cn.w, 1e-6 ) * hs;

				vec2 d = s1 - s0;
				float L = length( d );
				vec2 dir = L > 1e-4 ? d / L : vec2( 1., 0. );
				vec2 nrm = vec2( - dir.y, dir.x );
				vec2 dp = s0 - sp, dn = sn - s1;
				vec2 inDir = dot( dp, dp ) > 1e-8 ? normalize( dp ) : dir;
				vec2 outDir = dot( dn, dn ) > 1e-8 ? normalize( dn ) : dir;
				vec2 h0 = inDir + dir, h1 = dir + outDir;
				vec2 b0 = dot( h0, h0 ) > 1e-6 ? normalize( h0 ) : dir, b1 = dot( h1, h1 ) > 1e-6 ? normalize( h1 ) : dir;

				vStroke = strokeRadius( 1.2 + 12. * aW );
				vec3 r0 = min( blurRadii( - m0.z ), 300. ), r1 = min( blurRadii( - m1.z ), 300. );
				float w0 = vStroke + max( r0.r, max( r0.g, r0.b ) ), w1 = vStroke + max( r1.r, max( r1.g, r1.b ) );
				float m = max( w0, w1 ) + 1.;

				// A joint clips only when its miter fits well inside both segments; both neighbours see the same inputs.
				float tan0 = sqrt( max( 1. - dot( inDir, dir ), 0. ) / max( 1. + dot( inDir, dir ), 1e-3 ) );
				float tan1 = sqrt( max( 1. - dot( dir, outDir ), 0. ) / max( 1. + dot( dir, outDir ), 1e-3 ) );
				float join0 = aJoin.x * step( w0 * ( 1. + tan0 ), .5 * min( L, length( dp ) ) );
				float join1 = aJoin.y * step( w1 * ( 1. + tan1 ), .5 * min( L, length( dn ) ) );

				// Joined ends reach out to cover the miter; the bisector clip trims them to their half.
				float t = position.x, side = position.y;
				float reach = t < .5 ? m * ( 1. + join0 * min( tan0, 6. ) ) : m * ( 1. + join1 * min( tan1, 6. ) );
				vec2 p = mix( s0, s1, t ) + dir * ( t * 2. - 1. ) * reach + nrm * side * m;

				vLocal = vec2( dot( p - s0, dir ), side * m );
				vClip = vec2( dot( p - s0, b0 ), dot( s1 - p, b1 ) );
				vJoin = vec2( join0, join1 );
				vDist = aDist;
				vLength = L;
				vW = aW;
				vBlur = mix( r0, r1, t );
				gl_Position = vec4( p / hs, 0., 1. );
			}
		`,
		fragmentShader: /* glsl */`
			${arteryColorGLSL}
			${profileGLSL}
			varying vec2 vLocal, vClip, vJoin, vDist;
			varying float vLength, vStroke, vW;
			varying vec3 vBlur;

			float interval( float u, float L, float R, bool openStart, bool openEnd ) {
				return ( openStart ? .5 : discShare( u, R ) ) - ( openEnd ? - .5 : discShare( u - L, R ) );
			}

			void main() {
				// The growing tip is a free end wherever it has got to along this segment.
				float k = clamp( ( uGrow - vDist.x ) / max( vDist.y - vDist.x, 1e-3 ), 0., 1. );
				if ( k <= 0. ) discard;
				bool joinStart = vJoin.x > .5, joinEnd = vJoin.y > .5 && k >= 1.;
				if ( ( joinStart && vClip.x < 0. ) || ( joinEnd && vClip.y < 0. ) ) discard;

				// Outside the blurred footprint nothing is drawn, so skip the profile maths there.
				float u = vLocal.x, L = vLength * k, x = abs( vLocal.y );
				float reach = max( vBlur.r, max( vBlur.g, vBlur.b ) );
				if ( x > vStroke + reach || ( ! joinStart && u < - reach ) || ( ! joinEnd && u > L + reach ) ) discard;

				vec3 along, across;
				// Without visible chromatic aberration the channels match: evaluate one and share it.
				if ( abs( vBlur.r - vBlur.g ) + abs( vBlur.b - vBlur.g ) < .25 ) {
					along = vec3( interval( u, L, vBlur.g, joinStart, joinEnd ) );
					across = vec3( line( x, vStroke, vBlur.g ) );
				} else {
					along = vec3(
						interval( u, L, vBlur.r, joinStart, joinEnd ),
						interval( u, L, vBlur.g, joinStart, joinEnd ),
						interval( u, L, vBlur.b, joinStart, joinEnd ) );
					across = line3( x, vStroke, vBlur );
				}
				float dist = mix( vDist.x, vDist.y, clamp( u / max( vLength, 1e-3 ), 0., 1. ) );
				gl_FragColor = vec4( arteryColor( vW, dist, .35, .9 ) * across * along, 1. );
			}
		`,
	} );
}
