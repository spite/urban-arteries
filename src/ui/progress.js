// A single progress bar for a multi-stage load. It only moves forward, and creep() eases it toward a value
// over time while a stage gives nothing measurable. Styling is the page's: this toggles the classes
// reset / active / done / error and sets --p (0..1) on the element.
export function createProgress( el ) {
	let timer = 0;
	const progress = {
		value: 0,
		reset() {
			progress.stop();
			progress.value = 0;
			el.className = 'reset';
			el.style.setProperty( '--p', 0 );
			el.offsetWidth;
			el.className = 'active';
		},
		set( v ) {
			progress.value = Math.max( progress.value, Math.min( v, 1 ) );
			el.style.setProperty( '--p', progress.value );
		},
		creep( from, to, seconds ) {
			progress.stop();
			const t0 = performance.now();
			timer = setInterval( () => progress.set( from + ( to - from ) * ( 1 - Math.exp( - ( performance.now() - t0 ) / 1000 / seconds ) ) ), 100 );
		},
		stop() {
			clearInterval( timer );
		},
		done() {
			progress.stop();
			progress.set( 1 );
			el.className = 'done';
		},
		fail() {
			progress.stop();
			el.className = 'error';
		},
	};
	return progress;
}
