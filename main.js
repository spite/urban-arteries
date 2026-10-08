import { effect, untrack, signal, bindKey, createStats } from 'guspira';
import { loadCity } from './src/city.js';
import { geocode } from './src/geocode.js';
import { route, branches, toPaths, toDestinations, routeExtent } from './src/graph/routes.js';
import { createViewer } from './src/render/viewer.js';
import { fovOf } from './src/render/camera-rig.js';
import { createArteries } from './src/render/arteries.js';
import { createAdaptiveScale } from './src/render/adaptive.js';
import { buildPrintModel } from './src/print/model.js';
import { createProgress } from './src/ui/progress.js';
import { buildPanel } from './src/ui/panel.js';
import { writeUrl, readPlace } from './src/ui/url.js';
import { createSettings, CITIES, RADII } from './src/params.js';

const $ = ( id ) => document.getElementById( id );
const statusEl = $( 'status' );

const { params, presets } = createSettings();
const sceneRadius = signal( 1200 );
const info = { scale: signal( 1 ), nodes: signal( 0 ), segments: signal( 0 ), destinations: signal( 0 ), load: signal( 0 ), routing: signal( 0 ), exported: signal( '—' ) };
const progress = createProgress( $( 'progress' ) );

function setStatus( text, error = false ) {
	statusEl.textContent = text;
	statusEl.classList.toggle( 'error', error );
}

const MB = ( bytes ) => ( bytes / 1048576 ).toFixed( 1 ) + ' MB';
const nextFrame = () => new Promise( ( r ) => requestAnimationFrame( () => setTimeout( r ) ) );

// ---------------------------------------------------------------- view

const viewer = createViewer( $( 'container' ) );
const arteries = createArteries( viewer.lens );
viewer.scene.add( arteries.group );
viewer.controls.addEventListener( 'start', () => params.rotate.set( false ) );

const stats = createStats();
const fps = stats.fps();
const frameTime = stats.timer( 'frame' );
const adaptive = createAdaptiveScale( ( scale ) => {
	viewer.setScale( scale );
	info.scale.set( scale );
} );
let lastFrame = 0;

function animate() {
	const now = performance.now();
	if ( lastFrame ) adaptive.frame( now - lastFrame );
	lastFrame = now;
	frameTime.start();
	arteries.update( now, { grow: params.grow.peek(), pulse: params.pulse.peek() } );
	viewer.render();
	frameTime.end();
	fps.tick();
	stats.flush();
}

// ---------------------------------------------------------------- flow

let current = null;
let place = null;
let city = null;
let routing = 0;

async function reroute() {
	if ( ! city ) return;
	const token = ++ routing;
	const { g, origin, heights, radius, name } = city;
	const algorithm = params.algorithm.peek();
	const t0 = performance.now();
	const options = { algorithm, radius, count: params.count.peek(), layout: params.layout.peek(), depth: params.depth.peek(), bundling: params.bundling.peek() };
	const routes = await route( g, origin, options, {
		onRound: ( r, rounds ) => {
			if ( rounds < 2 ) return;
			progress.set( .95 + .05 * r / rounds );
			setStatus( `Routing ${name}… round ${r} / ${rounds}` );
		},
		cancelled: () => token !== routing,
	} );
	if ( ! routes ) return;
	city.paths = toPaths( g, heights, routes.dist, branches( routes ) );
	city.extent = routeExtent( g, routes );
	arteries.set( city.paths, { radius, maxDist: routes.maxDist, destinations: toDestinations( g, heights, routes ) } );
	arteries.replay();
	const ms = Math.round( performance.now() - t0 );
	const count = routes.segs.length;
	const what = algorithm === 'all' ? 'every street' : `${routes.destinations.length} destinations`;
	setStatus( `${name} · ${what} · ${count.toLocaleString()} street segments routed in ${ms} ms` );
	info.segments.set( count );
	info.destinations.set( routes.destinations.length );
	info.routing.set( ms );
}

async function show( next, keepProgress = false ) {
	current?.abort();
	if ( ! keepProgress ) progress.reset();
	const job = current = new AbortController();
	const radius = params.radius.peek();
	const started = performance.now();
	place = next;
	writeUrl( params.$toQuery(), place );
	document.querySelectorAll( '#cities a' ).forEach( ( a ) => a.classList.toggle( 'active', a.textContent === place.name ) );

	try {
		const loaded = await loadCity( place, {
			radius,
			source: params.source.peek(),
			signal: job.signal,
			pause: nextFrame,
			onProgress: ( { fraction, text, waiting } ) => {
				if ( waiting ) progress.creep( progress.value, fraction, 4 );
				else {
					progress.stop();
					progress.set( fraction );
				}
				setStatus( text );
			},
		} );
		if ( job.signal.aborted ) return;
		progress.set( .95 );
		setStatus( `Routing ${loaded.g.n.toLocaleString()} street nodes…` );
		await nextFrame();
		if ( job.signal.aborted ) return;

		city = { ...loaded, radius, name: place.name };
		sceneRadius.set( radius );
		info.nodes.set( loaded.g.n );
		await reroute();
		if ( job.signal.aborted ) return;
		viewer.frame( Math.max( city.extent || radius, radius * .3 ), { tilt: params.tilt.peek() } );
		progress.done();
		info.load.set( Math.round( performance.now() - started ) );
	} catch ( e ) {
		if ( job.signal.aborted ) return;
		console.error( e );
		progress.fail();
		setStatus( e.message || String( e ), true );
	}
}

async function exportSTL() {
	if ( ! city?.paths ) return;
	const { paths, ground, radius, name } = city;
	setStatus( 'Building the printable model…' );
	await nextFrame();
	const size = params.printSize.peek();
	const { blob, triangles } = buildPrintModel( paths, { radius, size, exag: params.terrain.target(), base: params.printBase.peek(), ground } );
	const a = document.createElement( 'a' );
	a.href = URL.createObjectURL( blob );
	a.download = `urban-arteries-${name.toLowerCase().replace( /[^a-z0-9]+/g, '-' ).replace( /^-|-$/g, '' )}.stl`;
	a.click();
	setTimeout( () => URL.revokeObjectURL( a.href ), 1000 );
	setStatus( `Exported ${a.download} · ${size} mm · ${triangles.toLocaleString()} triangles · ${MB( blob.size )}` );
	info.exported.set( `${triangles.toLocaleString()} triangles, ${MB( blob.size )}` );
}

async function search( query ) {
	try {
		current?.abort();
		progress.reset();
		progress.creep( 0, .08, 1 );
		setStatus( `Looking up “${query}”…` );
		show( await geocode( query ), true );
	} catch ( e ) {
		progress.fail();
		setStatus( e.message, true );
	}
}

// ---------------------------------------------------------------- page

const citiesEl = $( 'cities' );
for ( const [ name, lat, lon ] of CITIES ) {
	const li = document.createElement( 'li' );
	const a = document.createElement( 'a' );
	a.textContent = name;
	a.addEventListener( 'click', () => show( { name, lat, lon } ) );
	li.appendChild( a );
	citiesEl.appendChild( li );
}

$( 'search' ).addEventListener( 'submit', ( e ) => {
	e.preventDefault();
	const q = $( 'query' ).value.trim();
	if ( q ) search( q );
} );

$( 'locate' ).addEventListener( 'click', () => {
	setStatus( 'Waiting for your location…' );
	navigator.geolocation.getCurrentPosition(
		( p ) => show( { lat: p.coords.latitude, lon: p.coords.longitude, name: 'You are here' } ),
		( err ) => setStatus( err.message, true ),
	);
} );

// ---------------------------------------------------------------- settings

const { lens } = viewer;
effect( () => { lens.uAperture.value = params.aperture() / 100 * sceneRadius(); } );
effect( () => { lens.uChroma.value = params.chroma(); } );
effect( () => { lens.uRim.value = params.rim(); } );
effect( () => { viewer.setFov( fovOf( params.lens() ) ); } );
effect( () => { viewer.setTilt( params.tilt() ); } );
effect( () => { viewer.setLook( { exposure: params.exposure(), bloom: params.bloom(), grain: params.grain() } ); } );
effect( () => { arteries.setLook( { size: params.size(), exaggeration: params.terrain(), cold: params.cold(), warm: params.warm() } ); } );
effect( () => {
	viewer.setBackground( params.background() );
	document.body.style.background = params.background();
} );
effect( () => { viewer.controls.autoRotate = params.rotate(); } );
effect( () => { adaptive.setCeiling( params.resolution() ); } );
effect( () => { adaptive.setEnabled( params.adaptive() ); } );
effect( () => { arteries.setStyle( params.style() ); } );
effect( () => { arteries.setDestinationsVisible( params.targets() ); } );

// Routing reruns on the graph already loaded; a short debounce keeps a slider drag from queueing dozens.
let rerouteTimer = 0;
effect( () => {
	params.algorithm(); params.count(); params.layout(); params.depth(); params.bundling();
	clearTimeout( rerouteTimer );
	rerouteTimer = setTimeout( reroute, 150 );
} );

let started = false;
effect( () => {
	params.radius(); params.source();
	if ( started && place ) untrack( () => show( place ) );
	started = true;
} );

// Every setting change rewrites the URL; one debounced write covers a whole slider drag.
let urlTimer = 0;
effect( () => {
	for ( const key of params.$keys ) params[ key ].target();
	clearTimeout( urlTimer );
	urlTimer = setTimeout( () => writeUrl( params.$toQuery(), place ), 250 );
} );

buildPanel( $( 'gui-container' ), { params, presets, info, stats: { fps, frameTime }, actions: { replay: arteries.replay, exportSTL } } );

bindKey( 'Space', arteries.replay );
bindKey( 'KeyE', exportSTL );
bindKey( 'KeyL', () => params.style.set( params.style.peek() === 'lines' ? 'particles' : 'lines' ) );
bindKey( 'KeyT', () => params.targets.set( ! params.targets.peek() ) );

viewer.renderer.setAnimationLoop( animate );

const linked = readPlace( location.hash, { radii: RADII } );
if ( linked?.radius ) params.radius.set( linked.radius );
if ( linked ) {
	show( linked.place );
} else {
	const [ name, lat, lon ] = CITIES[ Math.floor( Math.random() * CITIES.length ) ];
	show( { name, lat, lon } );
}
