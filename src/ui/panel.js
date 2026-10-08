import { GUI } from 'guspira';
import { RADII } from '../params.js';

// The settings panel. Controls bind straight to the settings signals; actions are the app's buttons
// ({ replay, exportSTL }), info holds read-only signals for the Stats tab, stats its fps and frame timers.
export function buildPanel( container, { params, presets, info, stats, actions } ) {
	const radii = RADII.map( ( r ) => [ r, r < 1000 ? `${r} m` : `${r / 1000} km` ] );
	const fixed = { randomizable: false };
	const gui = new GUI( 'Urban Arteries', container, { storageKey: 'urban-arteries-gui' } );

	gui.addTab( 'Routes' );
	gui.addSection( 'Data' );
	gui.addSegmented( 'Streets', params.source, [ [ 'tiles', 'Map tiles' ], [ 'overpass', 'Overpass' ] ], { ...fixed, title: 'Map tiles are fast and reliable; Overpass has the full OpenStreetMap detail' } );
	gui.addSelect( 'Radius', params.radius, radii, fixed );
	gui.addSection( 'Routing' );
	gui.addSegmented( 'Algorithm', params.algorithm, [ [ 'main', 'Main' ], [ 'shortest', 'Shortest' ], [ 'all', 'Every' ] ], { ...fixed, title: 'Main streets with bundling, plain shortest paths, or the tree to every street' } );
	const routed = () => params.algorithm() !== 'all';
	gui.addSlider( 'Destinations', params.count, 10, 4000, 10, { ...fixed, curve: 2, visibleWhen: routed } );
	gui.addSegmented( 'Targets', params.layout, [ [ 'ring', 'Ring' ], [ 'scatter', 'Scattered' ] ], { ...fixed, visibleWhen: routed } );
	gui.addSlider( 'Ring depth', params.depth, 0, 1, .01, { ...fixed, curve: 2, visibleWhen: () => routed() && params.layout() === 'ring', title: 'How far in from the edge of the city destinations may lie, as a share of the radius' } );
	gui.addSlider( 'Bundling', params.bundling, 0, 1, .05, { ...fixed, visibleWhen: () => params.algorithm() === 'main', title: 'How strongly later routes merge onto streets earlier routes used' } );

	gui.addTab( 'Look' );
	gui.addRandomizeButton( 'Randomize look (R)', () => {} );
	gui.addSection( 'Render' );
	gui.addSegmented( 'Style', params.style, [ [ 'lines', 'Lines' ], [ 'particles', 'Particles' ] ] );
	gui.addCheckbox( 'Target dots (T)', params.targets, { ...fixed, title: 'A dot at every destination, fading as the routes reach it' } );
	gui.addSlider( 'Size', params.size, .25, 5, .05, { curve: 2 } ).randomize = () => params.size.set( +( .6 + Math.random() * 1.4 ).toFixed( 2 ) );
	gui.addSlider( 'Terrain', params.terrain, 0, 20, .1, { curve: 2 } ).randomize = () => params.terrain.set( +( Math.random() * 8 ).toFixed( 1 ) );
	gui.addSection( 'Lens' );
	gui.addSlider( 'Focal length', params.lens, 14, 300, 1, { curve: 'log', title: 'Millimetres, 35 mm equivalent; the camera dollies to keep the city the same size' } );
	gui.addSlider( 'Aperture %', params.aperture, 0, 200, .1, { curve: 3, title: 'Aperture diameter as a share of the radius; streets blur away from the focal plane at the orbit centre. Macro lenses open wider than the subject itself, so long focal lengths want large values' } );
	gui.addSlider( 'Chromatic', params.chroma, 0, 1, .01, { title: 'Longitudinal chromatic aberration: magenta fringes in front of focus, green behind' } );
	gui.addSlider( 'Bokeh rim', params.rim, 0, 1, .01, { title: 'Spherical aberration: pushes the light of out-of-focus streets toward their edges' } );
	gui.addSlider( 'Tilt', params.tilt, 2, 88, 1, { title: 'Camera height in degrees above the ground; low angles cut the focal plane across the city' } );
	gui.addSection( 'Light' );
	gui.addSlider( 'Exposure', params.exposure, .2, 4, .01, { curve: 'log' } );
	gui.addSlider( 'Bloom', params.bloom, 0, 2, .01 );
	gui.addSlider( 'Grain', params.grain, 0, .2, .005, { title: 'Film grain over the finished image; breaks up banding in smooth blur' } );
	gui.addSection( 'Colour' );
	gui.addColor( 'Side streets', params.cold );
	gui.addColor( 'Arteries', params.warm );
	gui.addColor( 'Background', params.background, fixed );
	gui.addSection( 'Motion' );
	gui.addSlider( 'Growth', params.grow, .5, 20, .5, { ...fixed, curve: 2, title: 'Seconds for the tree to grow out from the origin' } );
	gui.addCheckbox( 'Pulse', params.pulse, fixed );
	gui.addCheckbox( 'Auto-rotate', params.rotate, fixed );
	gui.addButton( 'Replay (Space)', actions.replay );

	gui.addTab( 'Print' );
	gui.addText( 'Each branch becomes a tube as thick as its traffic, with spheres at the joints, scaled to the diameter below. Binary STL in millimetres; slicers merge the overlapping shells.' );
	gui.addSlider( 'Diameter mm', params.printSize, 60, 300, 10, fixed );
	gui.addSegmented( 'Base', params.printBase, [ [ 'relief', 'Terrain' ], [ 'plate', 'Flat' ], [ 'none', 'None' ] ], { ...fixed, title: 'Terrain follows the Terrain exaggeration; Flat lays the routes on a plate' } );
	gui.addButton( 'Export STL (E)', actions.exportSTL );
	gui.addMonitor( 'Last export', info.exported );

	gui.addTab( 'Presets' );
	gui.addPresets( presets );

	gui.addTab( 'Stats' );
	gui.addGraph( 'Frame ms', stats.frameTime, { min: 0, over: 16.7 } );
	gui.addMonitor( 'FPS', stats.fps, { format: ( v ) => v.toFixed( 0 ), below: 50 } );
	gui.addSection( 'Performance' );
	gui.addSegmented( 'Pipeline', params.pipeline, [ [ 'layered', 'Layered' ], [ 'direct', 'Direct' ] ], { ...fixed, title: 'Layered blurs bands of the scene as images, at a cost that hardly depends on blur; Direct blurs every stroke itself' } );
	gui.addSlider( 'Resolution', params.resolution, .25, 1, .05, { ...fixed, title: 'Highest render resolution, as a share of the screen\'s' } );
	gui.addCheckbox( 'Adaptive', params.adaptive, { ...fixed, title: 'Lower the resolution while frames are slow, and raise it back when they are fast again' } );
	gui.addMonitor( 'Rendering at', info.scale, { format: ( v ) => `${Math.round( v * 100 )}%` } );
	gui.addSection( 'Scene' );
	const thousands = ( v ) => v.toLocaleString();
	gui.addMonitor( 'Street nodes', info.nodes, { format: thousands } );
	gui.addMonitor( 'Destinations', info.destinations, { format: thousands } );
	gui.addMonitor( 'Segments drawn', info.segments, { format: thousands } );
	gui.addMonitor( 'Load', info.load, { format: ( v ) => `${( v / 1000 ).toFixed( 1 )} s` } );
	gui.addMonitor( 'Routing', info.routing, { format: ( v ) => `${v} ms` } );
	return gui;
}
