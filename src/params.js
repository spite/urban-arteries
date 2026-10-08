import { createParams, createPresetStore, easings } from 'guspira';

export const CITIES = [
	[ 'Edinburgh', 55.9496, -3.1906 ],
	[ 'Prague', 50.0875, 14.4213 ],
	[ 'Porto', 41.1408, -8.6131 ],
	[ 'Barcelona', 41.3870, 2.1701 ],
	[ 'Venice', 45.4380, 12.3359 ],
	[ 'Paris', 48.8738, 2.2950 ],
	[ 'Manhattan', 40.7308, -73.9973 ],
	[ 'San Francisco', 37.7930, -122.4161 ],
	[ 'Kyoto', 35.0037, 135.7788 ],
	[ 'Fès', 34.0646, -4.9730 ],
];

export const RADII = [ 600, 1200, 2000, 3000, 4000, 5000 ];

export const DEFAULTS = {
	source: 'tiles',
	radius: 1200,
	algorithm: 'main',
	count: 800,
	layout: 'ring',
	depth: .1,
	bundling: .6,
	style: 'lines',
	aperture: 6,
	lens: 26,
	tilt: 24,
	rim: .2,
	exposure: 1.1,
	bloom: .3,
	grain: .035,
	bloomThreshold: 1,
	size: 1,
	terrain: 2,
	cold: '#5280ff',
	warm: '#ffcc8c',
	background: '#05060a',
	grow: 5,
	pulse: true,
	targets: true,
	rotate: true,
	resolution: 1,
	adaptive: true,
	debugView: 'final',
	debugBand: 0,
	debugStage: 'blurred',
	debugGain: 1,
	bandCount: 9,
	bandFirst: 2,
	bandLargest: 256,
	bandTexels: 3,
	blurTaps: 48,
	bandBlend: true,
	cubic: true,
	printSize: 150,
	printBase: 'relief',
};

export const PRESETS = {
	Dendrite: { algorithm: 'main', bundling: 1, count: 1200, layout: 'ring', style: 'lines', aperture: 5, size: 1 },
	'Soft focus': { style: 'particles', aperture: 12, size: 1.4 },
	'Sharp lines': { style: 'lines', aperture: 0, size: 1.2 },
	'Every street': { algorithm: 'all', style: 'lines', aperture: 3, size: .6 },
	Scattered: { algorithm: 'shortest', layout: 'scatter', count: 400 },
	Ember: { cold: '#ff5a36', warm: '#ffe08a', background: '#0a0503' },
	Ice: { cold: '#3a6bff', warm: '#c8f0ff', background: '#02040a' },
	Macro: { style: 'lines', lens: 135, tilt: 12, aperture: 80, rim: .5, bloom: .45, exposure: 1.25, grain: .05 },
	Microscope: { style: 'lines', lens: 200, tilt: 62, aperture: 60, rim: .3, bloom: .6, exposure: 1.3, cold: '#1fd47a', warm: '#d9ffe6', background: '#000302' },
};

// One typed store for every setting: saved between visits, read from the URL (?style=lines), and the looks ease
// between values instead of jumping. A URL that carries settings is the whole state: anything it leaves out is at
// its default, so saved settings are neither read nor overwritten and a shared link looks the same for everyone.
export function createSettings() {
	const query = typeof location !== 'undefined' ? new URLSearchParams( location.search ) : new URLSearchParams();
	const linked = Object.keys( DEFAULTS ).some( ( key ) => query.has( key ) );
	const params = createParams( DEFAULTS, {
		storageKey: linked ? null : 'urban-arteries',
		url: true,
		// Saves from before the default rose from 150 to 800 still hold the old default; let them take the new one.
		migrate: ( stored ) => {
			if ( stored.count === 150 ) delete stored.count;
			return stored;
		},
		ease: { duration: 450, easing: easings.cubicOut, only: [ 'aperture', 'lens', 'tilt', 'rim', 'exposure', 'bloom', 'grain', 'size', 'terrain', 'cold', 'warm', 'background' ] },
	} );
	const presets = createPresetStore( params, {
		storageKey: 'urban-arteries-presets',
		exclude: [ 'printSize', 'printBase', 'resolution', 'adaptive', 'debugView', 'debugBand', 'debugStage', 'debugGain', 'bandCount', 'bandFirst', 'bandLargest', 'bandTexels', 'blurTaps', 'bandBlend', 'cubic' ],
		builtin: PRESETS,
	} );
	return { params, presets };
}
