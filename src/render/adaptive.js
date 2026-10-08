// Adaptive render resolution. Feed it the time between frames; when frames stay slow it lowers the scale, and
// after a long run of fast frames it raises it again, so the picture only softens while the GPU can't keep up.
// onChange( scale ) applies it, e.g. viewer.setScale.
export function createAdaptiveScale( onChange, { min = .4, slow = 24, fast = 15 } = {} ) {
	let scale = 1, ceiling = 1, enabled = true;
	let average = 16, slowFrames = 0, fastFrames = 0;
	const apply = ( value ) => {
		value = Math.min( Math.max( value, min ), ceiling );
		if ( Math.abs( value - scale ) < 1e-3 ) return;
		scale = value;
		onChange( scale );
	};
	return {
		get scale() { return scale; },
		// Highest scale allowed (0..1); with adaptation off the scale is held there.
		setCeiling( value ) {
			ceiling = value;
			apply( enabled ? Math.min( scale, ceiling ) : ceiling );
		},
		setEnabled( value ) {
			enabled = value;
			if ( ! enabled ) apply( ceiling );
		},
		frame( ms ) {
			if ( ! enabled || ms > 250 ) return;
			average += ( ms - average ) * .1;
			slowFrames = average > slow ? slowFrames + 1 : 0;
			fastFrames = average < fast ? fastFrames + 1 : 0;
			if ( slowFrames > 20 ) {
				slowFrames = 0;
				apply( scale * .8 );
			} else if ( fastFrames > 120 && scale < ceiling ) {
				fastFrames = 0;
				apply( scale * 1.15 );
			}
		},
	};
}
