import * as THREE from 'three';
import { defocusGLSL, arteryColorGLSL, binGLSL } from './chunks.js';

// Materials for the layered pipeline (layered.js): everything is drawn sharp into one blur band at a time, at that
// band's resolution, carrying the share of its light that belongs to the band. Strokes thinner than a texel are
// drawn a texel wide with their light scaled down, so a band keeps the right amount of light at any resolution.

// Lines, on the per-segment geometry from strips.js stripGeometry().
export function createSharpLineMaterial( uniforms ) {
	return new THREE.ShaderMaterial( {
		uniforms,
		transparent: true,
		depthWrite: false,
		depthTest: false,
		blending: THREE.AdditiveBlending,
		vertexShader: /* glsl */`
			uniform float uExag;
			${defocusGLSL}
			${binGLSL}
			attribute vec3 aStart, aEnd, aPrev, aNext;
			attribute vec2 aJoin, aDist;
			attribute float aW;
			varying vec2 vLocal, vClip, vJoin, vDist;
			varying float vLength, vHalf, vLight, vW;
			varying vec3 vShare;

			vec4 view( vec3 p ) { return modelViewMatrix * vec4( p * vec3( 1., uExag, 1. ), 1. ); }

			void main() {
				vec4 m0 = view( aStart ), m1 = view( aEnd );
				vec3 w0 = binWeights( exactBlurRadii( - m0.z ) ), w1 = binWeights( exactBlurRadii( - m1.z ) );
				vec4 c0 = projectionMatrix * m0, c1 = projectionMatrix * m1;
				if ( c0.w <= 0. || c1.w <= 0. || max( max( w0.r, w0.g ), max( max( w0.b, w1.r ), max( w1.g, w1.b ) ) ) <= 0. ) {
					gl_Position = vec4( 2., 2., 2., 1. );
					return;
				}
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

				float halfWidth = strokeRadius( 1.2 + 12. * aW ) * uBinScale;
				vHalf = max( halfWidth, .5 );
				vLight = halfWidth / vHalf;
				float m = vHalf + 1.;
				float tan0 = sqrt( max( 1. - dot( inDir, dir ), 0. ) / max( 1. + dot( inDir, dir ), 1e-3 ) );
				float tan1 = sqrt( max( 1. - dot( dir, outDir ), 0. ) / max( 1. + dot( dir, outDir ), 1e-3 ) );
				float join0 = aJoin.x * step( m * ( 1. + tan0 ), .5 * min( L, length( dp ) ) );
				float join1 = aJoin.y * step( m * ( 1. + tan1 ), .5 * min( L, length( dn ) ) );

				float t = position.x, side = position.y;
				float reach = t < .5 ? m * ( 1. + join0 * min( tan0, 6. ) ) : m * ( 1. + join1 * min( tan1, 6. ) );
				vec2 p = mix( s0, s1, t ) + dir * ( t * 2. - 1. ) * reach + nrm * side * m;

				vLocal = vec2( dot( p - s0, dir ), side * m );
				vClip = vec2( dot( p - s0, b0 ), dot( s1 - p, b1 ) );
				vJoin = vec2( join0, join1 );
				vDist = aDist;
				vLength = L;
				vW = aW;
				vShare = mix( w0, w1, t );
				gl_Position = vec4( p / hs, 0., 1. );
			}
		`,
		fragmentShader: /* glsl */`
			${arteryColorGLSL}
			varying vec2 vLocal, vClip, vJoin, vDist;
			varying float vLength, vHalf, vLight, vW;
			varying vec3 vShare;

			void main() {
				float k = clamp( ( uGrow - vDist.x ) / max( vDist.y - vDist.x, 1e-3 ), 0., 1. );
				if ( k <= 0. ) discard;
				bool joinStart = vJoin.x > .5, joinEnd = vJoin.y > .5 && k >= 1.;
				if ( ( joinStart && vClip.x < 0. ) || ( joinEnd && vClip.y < 0. ) ) discard;
				float u = vLocal.x, L = vLength * k;
				float across = clamp( vHalf - abs( vLocal.y ) + .5, 0., 1. );
				float along = ( joinStart ? 1. : clamp( u + .5, 0., 1. ) ) * ( joinEnd ? 1. : clamp( L - u + .5, 0., 1. ) );
				float dist = mix( vDist.x, vDist.y, clamp( u / max( vLength, 1e-3 ), 0., 1. ) );
				gl_FragColor = vec4( arteryColor( vW, dist, .35, .9 ) * vShare * across * along * vLight, 1. );
			}
		`,
	} );
}

// Round sharp points: the particles (weighted by aW) and the destination dots (a fixed stroke, faded by growth).
function sharpPoints( uniforms, { stroke, fade, color, extra = {} } ) {
	return new THREE.ShaderMaterial( {
		uniforms: { ...uniforms, ...extra },
		transparent: true,
		depthWrite: false,
		depthTest: false,
		blending: THREE.AdditiveBlending,
		vertexShader: /* glsl */`
			uniform float uGrow, uExag;
			${fade ? 'uniform float uFade;' : ''}
			${defocusGLSL}
			${binGLSL}
			attribute float aDist;
			${stroke.includes( 'aW' ) ? 'attribute float aW;' : ''}
			varying float vW, vDist, vRadius, vLight, vSize, vFade;
			varying vec3 vShare;

			void main() {
				vec4 mv = modelViewMatrix * vec4( position * vec3( 1., uExag, 1. ), 1. );
				vShare = binWeights( exactBlurRadii( - mv.z ) );
				${stroke.includes( 'aW' ) ? 'vW = aW;' : 'vW = 0.;'}
				vDist = aDist;
				vFade = ${fade ? 'smoothstep( 0., uFade, aDist - uGrow )' : 'aDist <= uGrow ? 1. : 0.'};
				float r = strokeRadius( ${stroke} ) * uBinScale;
				vRadius = max( r, .5 );
				vLight = ( r * r ) / ( vRadius * vRadius );
				vSize = 2. * vRadius + 2.;
				bool visible = vFade > 0. && max( vShare.r, max( vShare.g, vShare.b ) ) > 0.;
				gl_Position = visible ? projectionMatrix * mv : vec4( 2., 2., 2., 1. );
				gl_PointSize = visible ? vSize : 0.;
			}
		`,
		fragmentShader: /* glsl */`
			${arteryColorGLSL}
			varying float vW, vDist, vRadius, vLight, vSize, vFade;
			varying vec3 vShare;

			void main() {
				float cover = clamp( vRadius - length( gl_PointCoord - .5 ) * vSize + .5, 0., 1. );
				gl_FragColor = vec4( ${color} * vShare * cover * vLight * vFade, 1. );
			}
		`,
	} );
}

export function createSharpParticleMaterial( uniforms ) {
	return sharpPoints( uniforms, { stroke: '1.6 + 4. * aW', fade: false, color: 'arteryColor( vW, vDist, .3, .7 ) * .7' } );
}

export function createSharpTargetMaterial( uniforms ) {
	return sharpPoints( uniforms, { stroke: '6.', fade: true, color: 'mix( uCold, vec3( 1. ), .6 )', extra: { uFade: { value: 100 } } } );
}
