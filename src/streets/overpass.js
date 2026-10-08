// Walkable streets around a point from the Overpass API, as OSM elements (ways with tags, then their nodes).
// Tries each endpoint in turn and keeps answers in Cache Storage, so a place already fetched loads offline.

export const OVERPASS_ENDPOINTS = [
	'https://overpass-api.de/api/interpreter',
	'https://overpass.private.coffee/api/interpreter',
	'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

export const WALKABLE_FILTER = '["highway"]["highway"!~"^(motorway|motorway_link|construction|proposed|abandoned|raceway|bus_guideway|platform|escape)$"]\n\t["foot"!="no"]["access"!~"^(private|no)$"]["footway"!~"^(sidewalk|crossing)$"]["service"!~"^(parking_aisle|driveway)$"]';

// onProgress receives { host, bytes }: bytes is 0 while a server is still working on the query.
// Outside a browser, pass headers with a descriptive User-Agent; overpass-api.de refuses generic ones.
export async function fetchStreetsFromOverpass( lat, lon, radius, {
	signal,
	onProgress = () => {},
	endpoints = OVERPASS_ENDPOINTS,
	filter = WALKABLE_FILTER,
	cacheName = 'urban-arteries',
	headers = {},
} = {} ) {
	const query = `[out:json][timeout:60];
way${filter}(around:${radius},${lat},${lon});
out body qt;
>;
out skel qt;`;
	const key = 'https://overpass.cache/?' + encodeURIComponent( query );
	const cache = cacheName && typeof caches !== 'undefined' ? await caches.open( cacheName ).catch( () => null ) : null;
	const hit = await cache?.match( key );
	if ( hit ) return ( await hit.json() ).elements;

	const errors = [];
	for ( const endpoint of endpoints ) {
		const host = new URL( endpoint ).host;
		try {
			onProgress( { host, bytes: 0 } );
			const res = await fetch( endpoint, {
				method: 'POST',
				body: 'data=' + encodeURIComponent( query ),
				headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
				signal,
			} );
			if ( ! res.ok ) throw new Error( `${host}: ${res.status}` );
			const chunks = [];
			let bytes = 0;
			for ( const reader = res.body.getReader(); ; ) {
				const { done, value } = await reader.read();
				if ( done ) break;
				chunks.push( value );
				bytes += value.length;
				onProgress( { host, bytes } );
			}
			const text = await new Blob( chunks ).text();
			cache?.put( key, new Response( text ) ).catch( () => {} );
			return JSON.parse( text ).elements;
		} catch ( e ) {
			if ( signal?.aborted ) throw e;
			errors.push( e.message );
		}
	}
	throw new Error( `Street data servers are busy, try again in a minute (${errors.join( '; ' )})` );
}
