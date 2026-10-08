// Share links: settings in the query, the place in the hash as lat,lon,name.

// query: a query string without '?', e.g. from guspira's params.$toQuery().
export function writeUrl( query, place ) {
	const hash = place ? `#${place.lat.toFixed( 5 )},${place.lon.toFixed( 5 )},${encodeURIComponent( place.name )}` : location.hash;
	history.replaceState( null, '', location.pathname + ( query ? '?' + query : '' ) + hash );
}

// Resolves a hash to { place, radius }, or null when it holds no place. Older links put the radius third; a third
// part that is one of `radii` is read as one rather than as a name.
export function readPlace( hash, { radii = [] } = {} ) {
	const [ lat, lon, ...rest ] = hash.replace( /^#/, '' ).split( ',' );
	if ( lat === '' || lon === undefined || lon === '' || ! Number.isFinite( + lat ) || ! Number.isFinite( + lon ) ) return null;
	let radius = null;
	if ( rest.length === 1 && radii.includes( + rest[ 0 ] ) ) radius = + rest.pop();
	const name = rest.length ? decodeURIComponent( rest.join( ',' ) ) : `${( + lat ).toFixed( 4 )}, ${( + lon ).toFixed( 4 )}`;
	return { place: { lat: + lat, lon: + lon, name }, radius };
}
