// Place search through Nominatim; "lat,lon" is taken as-is without a request.
// Resolves to { lat, lon, name }. Nominatim's policy allows about one request per second.

export async function geocode( query, { language = typeof navigator !== 'undefined' ? navigator.language : 'en', signal } = {} ) {
	const m = query.match( /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/ );
	if ( m ) return { lat: +m[ 1 ], lon: +m[ 2 ], name: query.trim() };
	const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' + encodeURIComponent( query );
	const res = await fetch( url, { headers: { 'Accept-Language': language }, signal } );
	if ( ! res.ok ) throw new Error( `Search failed (${res.status})` );
	const [ hit ] = await res.json();
	if ( ! hit ) throw new Error( `Nothing found for “${query}”` );
	return { lat: +hit.lat, lon: +hit.lon, name: hit.display_name.split( ',' )[ 0 ] };
}
