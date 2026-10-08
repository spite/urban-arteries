// Captions over the depth-of-field debug grid: each tile's band, blur radius and resolution. The grid matches
// LayeredPass: columns = ceil( √bands ), filled left to right, top to bottom.
export function createBandLabels( container ) {
	const root = document.createElement( 'div' );
	root.className = 'band-labels';
	container.appendChild( root );
	return {
		update( bands, visible ) {
			root.hidden = ! visible;
			if ( ! visible ) return;
			const columns = Math.ceil( Math.sqrt( bands.length ) ), rows = Math.ceil( bands.length / columns );
			root.replaceChildren( ...bands.map( ( { radius, width, height }, i ) => {
				const label = document.createElement( 'span' );
				label.textContent = `${i} · blur ${+ radius.toFixed( 2 )} px · ${width}×${height}`;
				label.style.left = `${( i % columns ) / columns * 100}%`;
				label.style.top = `${Math.floor( i / columns ) / rows * 100}%`;
				return label;
			} ) );
		},
	};
}
