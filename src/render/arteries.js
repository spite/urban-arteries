import * as THREE from 'three';
import { createLensMaterial } from '../lens/material.js';
import { segmentGeometry, particleGeometry, destinationGeometry } from './geometry.js';

// Draws a routed network (paths from graph/routes.js toPaths) as lines or particles, growing out from the origin
// and then pulsing, with optional dots at the destinations that fade as the routes reach them, and a marker at the
// origin. Everything is lens light (lens/material.js): add `group` to a scene rendered through LayeredPass and
// call update() every frame.

// Colour by weight (0 side street … 1 main artery), plus the glow at the growth front and the travelling pulse.
const colorGLSL = /* glsl */`
	uniform float uGrow, uPulse;
	uniform vec3 uCold, uWarm;

	vec3 arteryColor( float weight, float dist, float base, float gain ) {
		float tip = exp( - max( uGrow - dist, 0. ) / 60. );
		float pulse = uPulse > 0. ? exp( - abs( uPulse - dist ) / 25. ) * ( .3 + weight ) : 0.;
		float t = pow( weight, .5 );
		return mix( uCold, uWarm, t ) * ( base + gain * t ) + uWarm * ( tip + pulse );
	}
`;

// Lines: one quad per segment (geometry.js segmentGeometry), drawn sharp and antialiased in the band's pixels as
// a capsule, cut at the bisector where two segments of a path meet: the two capsules mirror each other across it,
// so every corner comes out round at any angle, without a gap or a doubled overlap. A stroke thinner than
// a pixel is drawn a pixel wide with its light scaled down, so it carries the right amount at any band resolution.
function lineMaterial( lens, uniforms ) {
	return createLensMaterial( lens, {
		uniforms,
		vertexShader: /* glsl */`
			uniform float uExag, uSize;
			attribute vec3 aStart, aEnd, aPrev, aNext;
			attribute vec2 aJoin, aDist;
			attribute float aW;
			// vLocal: band pixels along the segment from its start, and across from its axis. vClip: signed pixels
			// on this segment's side of the bisectors at its start and end. Linear in screen space, hence w = 1 below.
			varying vec2 vLocal, vClip, vJoin, vDist;
			varying float vLength, vHalf, vLight, vW;
			varying float vShare;

			vec4 view( vec3 p ) { return modelViewMatrix * vec4( p * vec3( 1., uExag, 1. ), 1. ); }

			void main() {
				vec4 m0 = view( aStart ), m1 = view( aEnd );
				float w0 = bandWeight( blurRadius( - m0.z ) ), w1 = bandWeight( blurRadius( - m1.z ) );
				vec4 c0 = projectionMatrix * m0, c1 = projectionMatrix * m1;
				if ( c0.w <= 0. || c1.w <= 0. || max( w0, w1 ) <= 0. ) {
					gl_Position = vec4( 2., 2., 2., 1. );
					return;
				}
				vec2 s0 = bandScreen( c0 ), s1 = bandScreen( c1 );
				vec4 cp = projectionMatrix * view( aPrev ), cn = projectionMatrix * view( aNext );
				vec2 sp = cp.xy / max( cp.w, 1e-6 ) * .5 * uResolution, sn = cn.xy / max( cn.w, 1e-6 ) * .5 * uResolution;

				vec2 d = s1 - s0;
				float L = length( d );
				vec2 dir = L > 1e-4 ? d / L : vec2( 1., 0. );
				vec2 nrm = vec2( - dir.y, dir.x );
				vec2 dp = s0 - sp, dn = sn - s1;
				vec2 inDir = dot( dp, dp ) > 1e-8 ? normalize( dp ) : dir;
				vec2 outDir = dot( dn, dn ) > 1e-8 ? normalize( dn ) : dir;
				vec2 h0 = inDir + dir, h1 = dir + outDir;
				vec2 b0 = dot( h0, h0 ) > 1e-6 ? normalize( h0 ) : dir, b1 = dot( h1, h1 ) > 1e-6 ? normalize( h1 ) : dir;

				float halfWidth = bandPixels( ( 1.2 + 12. * aW ) * .35 * uSize );
				vHalf = max( halfWidth, .5 );
				vLight = halfWidth / vHalf;
				float m = vHalf + 1.;

				float t = position.x, side = position.y;
				vec2 p = mix( s0, s1, t ) + ( dir * ( t * 2. - 1. ) + nrm * side ) * m;

				vLocal = vec2( dot( p - s0, dir ), side * m );
				vClip = vec2( dot( p - s0, b0 ), dot( s1 - p, b1 ) );
				vJoin = aJoin;
				vDist = aDist;
				vLength = L;
				vW = aW;
				vShare = mix( w0, w1, t );
				gl_Position = vec4( p / ( .5 * uResolution ), 0., 1. );
			}
		`,
		fragmentShader: /* glsl */`
			${colorGLSL}
			varying vec2 vLocal, vClip, vJoin, vDist;
			varying float vLength, vHalf, vLight, vW;
			varying float vShare;

			void main() {
				float k = clamp( ( uGrow - vDist.x ) / max( vDist.y - vDist.x, 1e-3 ), 0., 1. );
				if ( k <= 0. ) discard;
				bool joinStart = vJoin.x > .5, joinEnd = vJoin.y > .5 && k >= 1.;
				if ( ( joinStart && vClip.x < 0. ) || ( joinEnd && vClip.y < 0. ) ) discard;
				float u = vLocal.x;
				// Round past the end and behind a joined start; a path's free start sits on its parent and stays flat.
				float beyond = max( u - vLength * k, 0. ) + ( joinStart ? min( u, 0. ) : 0. );
				float cover = clamp( vHalf - length( vec2( beyond, vLocal.y ) ) + .5, 0., 1. ) * ( joinStart ? 1. : clamp( u + .5, 0., 1. ) );
				float dist = mix( vDist.x, vDist.y, clamp( u / max( vLength, 1e-3 ), 0., 1. ) );
				gl_FragColor = vec4( arteryColor( vW, dist, .35, .9 ) * vShare * cover * vLight, 1. );
			}
		`,
	} );
}

// Round sharp points: the particles (sized and coloured by weight) and the destination dots (a fixed size,
// fading out over uFade metres of path as the growth front arrives).
function pointMaterial( lens, uniforms, { destinations } ) {
	return createLensMaterial( lens, {
		uniforms,
		vertexShader: /* glsl */`
			uniform float uExag, uSize, uGrow, uFade;
			attribute float aDist;
			${destinations ? '' : 'attribute float aW;'}
			varying float vW, vDist, vRadius, vLight, vSize, vFade;
			varying float vShare;

			void main() {
				vec4 mv = modelViewMatrix * vec4( position * vec3( 1., uExag, 1. ), 1. );
				vShare = bandWeight( blurRadius( - mv.z ) );
				vW = ${destinations ? '0.' : 'aW'};
				vDist = aDist;
				vFade = ${destinations ? 'smoothstep( 0., uFade, aDist - uGrow )' : 'aDist <= uGrow ? 1. : 0.'};
				float r = bandPixels( ( ${destinations ? '6.' : '1.6 + 4. * aW'} ) * .35 * uSize );
				vRadius = max( r, .5 );
				vLight = ( r * r ) / ( vRadius * vRadius );
				vSize = 2. * vRadius + 2.;
				bool visible = vFade > 0. && vShare > 0.;
				gl_Position = visible ? projectionMatrix * mv : vec4( 2., 2., 2., 1. );
				gl_PointSize = visible ? vSize : 0.;
			}
		`,
		fragmentShader: /* glsl */`
			${colorGLSL}
			varying float vW, vDist, vRadius, vLight, vSize, vFade;
			varying float vShare;

			void main() {
				float cover = clamp( vRadius - length( gl_PointCoord - .5 ) * vSize + .5, 0., 1. );
				vec3 color = ${destinations ? 'mix( uCold, vec3( 1. ), .6 )' : 'arteryColor( vW, vDist, .3, .7 ) * .7'};
				gl_FragColor = vec4( color * vShare * cover * vLight * vFade, 1. );
			}
		`,
	} );
}

// The origin: a glowing point with a ring pulsing out of it. Always in focus, i.e. a blur radius of 0.
function markerMaterial( lens, uniforms ) {
	return createLensMaterial( lens, {
		uniforms,
		vertexShader: /* glsl */`
			uniform float uExag;
			varying float vShare;
			void main() {
				vShare = bandWeight( 0. );
				gl_Position = projectionMatrix * modelViewMatrix * vec4( position * vec3( 1., uExag, 1. ), 1. );
				gl_PointSize = bandPixels( 48. );
			}
		`,
		fragmentShader: /* glsl */`
			uniform float uTime;
			varying float vShare;
			void main() {
				float d = length( gl_PointCoord - .5 ) * 2.;
				float ring = exp( - abs( d - fract( uTime * .5 ) ) * 20. ) * ( 1. - fract( uTime * .5 ) );
				float core = exp( - d * 9. );
				gl_FragColor = vec4( vec3( 1., .85, .6 ) * ( core * 1.5 + ring ) * vShare, 1. );
			}
		`,
	} );
}

// lens: the viewer's lens uniforms (lens/uniforms.js).
export function createArteries( lens ) {
	const uniforms = {
		uGrow: { value: 1e9 }, // path distance the growth has reached
		uPulse: { value: - 1 }, // path distance of the travelling pulse; negative when there is none
		uExag: { value: 1 }, // vertical exaggeration of the terrain
		uSize: { value: 1 }, // stroke size multiplier
		uCold: { value: new THREE.Color( '#5280ff' ) }, // side streets
		uWarm: { value: new THREE.Color( '#ffcc8c' ) }, // main arteries
		uFade: { value: 100 }, // metres of path over which a destination dot fades
		uTime: { value: 0 },
	};
	const materials = {
		lines: lineMaterial( lens, uniforms ),
		particles: pointMaterial( lens, uniforms, { destinations: false } ),
		destinations: pointMaterial( lens, uniforms, { destinations: true } ),
		marker: markerMaterial( lens, uniforms ),
	};

	const group = new THREE.Group();
	const markerGeometry = new THREE.BufferGeometry();
	markerGeometry.setAttribute( 'position', new THREE.Float32BufferAttribute( [ 0, 0, 0 ], 3 ) );
	const marker = new THREE.Points( markerGeometry, materials.marker );
	marker.frustumCulled = false;
	group.add( marker );

	let meshes = {};
	let style = 'lines', showDestinations = true;
	let growStart = 0, maxDist = 1;
	const box = new THREE.Box3( new THREE.Vector3(), new THREE.Vector3() );

	function applyVisibility() {
		if ( meshes.lines ) meshes.lines.visible = style === 'lines';
		if ( meshes.particles ) meshes.particles.visible = style === 'particles';
		if ( meshes.destinations ) meshes.destinations.visible = showDestinations;
	}

	function clear() {
		for ( const m of Object.values( meshes ) ) {
			group.remove( m );
			m.geometry.dispose();
		}
		meshes = {};
	}

	return {
		group,
		// radius sets the detail: segments are split every radius/150, particles spaced radius/320. maxDist is the
		// longest path distance, where growth ends. destinations: [ { point, dist } ] (routes.js toDestinations).
		set( paths, { radius, maxDist: longest, destinations = [] } ) {
			clear();
			meshes = {
				lines: new THREE.Mesh( segmentGeometry( paths, { step: radius / 150 } ), materials.lines ),
				particles: new THREE.Points( particleGeometry( paths, { spacing: radius / 320 } ), materials.particles ),
				destinations: new THREE.Points( destinationGeometry( destinations ), materials.destinations ),
			};
			for ( const m of Object.values( meshes ) ) {
				m.frustumCulled = false;
				group.add( m );
			}
			box.set( new THREE.Vector3(), new THREE.Vector3() );
			for ( const { points } of paths ) for ( const p of points ) box.expandByPoint( new THREE.Vector3( ...p ) );
			for ( const { point } of destinations ) box.expandByPoint( new THREE.Vector3( ...point ) );
			uniforms.uFade.value = Math.max( longest * .15, 1 );
			maxDist = longest;
			applyVisibility();
		},
		// A sphere around everything drawn, heights exaggerated as they are drawn; for LayeredPass.bounds.
		get bounds() {
			const exag = new THREE.Vector3( 1, uniforms.uExag.value, 1 );
			return new THREE.Box3( box.min.clone().multiply( exag ), box.max.clone().multiply( exag ) ).getBoundingSphere( new THREE.Sphere() );
		},
		// style: 'lines' or 'particles'.
		setStyle( value ) {
			style = value;
			applyVisibility();
		},
		setDestinationsVisible( value ) {
			showDestinations = value;
			applyVisibility();
		},
		// Colours are CSS colours; size scales the strokes; exaggeration scales heights.
		setLook( { size, exaggeration, cold, warm } ) {
			if ( size !== undefined ) uniforms.uSize.value = size;
			if ( exaggeration !== undefined ) uniforms.uExag.value = exaggeration;
			if ( cold !== undefined ) uniforms.uCold.value.set( cold );
			if ( warm !== undefined ) uniforms.uWarm.value.set( warm );
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
			uniforms.uTime.value = now / 1000;
		},
		dispose() {
			clear();
			markerGeometry.dispose();
			for ( const m of Object.values( materials ) ) m.dispose();
		},
	};
}
