// Ground height from Terrarium elevation tiles (AWS Terrain Tiles by default; free, no key).
// Returns the height in metres at every given point, and a bilinear sampler for anywhere inside the loaded area.

export const TERRARIUM = ( z, x, y ) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

const DEG = Math.PI / 180;

// include( i ) limits which points decide the area to download, e.g. to keep a long road out of the box.
// onProgress receives ( loaded, total ) tiles. Needs OffscreenCanvas and createImageBitmap.
export async function loadTerrain( lats, lons, {
	zoom = 14,
	include = () => true,
	signal,
	onProgress = () => {},
	url = TERRARIUM,
} = {} ) {
	const n = 2 ** zoom;
	const px = ( lon ) => ( lon + 180 ) / 360 * n * 256;
	const py = ( lat ) => ( 1 - Math.log( Math.tan( lat * DEG ) + 1 / Math.cos( lat * DEG ) ) / Math.PI ) / 2 * n * 256;

	let minX = Infinity, maxX = - Infinity, minY = Infinity, maxY = - Infinity;
	for ( let i = 0; i < lats.length; i ++ ) {
		if ( ! include( i ) ) continue;
		const x = px( lons[ i ] ), y = py( lats[ i ] );
		minX = Math.min( minX, x ); maxX = Math.max( maxX, x );
		minY = Math.min( minY, y ); maxY = Math.max( maxY, y );
	}
	const tx0 = Math.floor( minX / 256 ), tx1 = Math.floor( ( maxX + 1 ) / 256 );
	const ty0 = Math.floor( minY / 256 ), ty1 = Math.floor( ( maxY + 1 ) / 256 );
	const w = ( tx1 - tx0 + 1 ) * 256, h = ( ty1 - ty0 + 1 ) * 256;
	const canvas = new OffscreenCanvas( w, h );
	const ctx = canvas.getContext( '2d', { willReadFrequently: true } );

	const jobs = [];
	const total = ( tx1 - tx0 + 1 ) * ( ty1 - ty0 + 1 );
	let loaded = 0;
	onProgress( 0, total );
	for ( let ty = ty0; ty <= ty1; ty ++ ) for ( let tx = tx0; tx <= tx1; tx ++ ) {
		jobs.push( fetch( url( zoom, tx, ty ), { signal } )
			.then( ( r ) => r.blob() )
			.then( createImageBitmap )
			.then( ( img ) => {
				ctx.drawImage( img, ( tx - tx0 ) * 256, ( ty - ty0 ) * 256 );
				onProgress( ++ loaded, total );
			} ) );
	}
	await Promise.all( jobs );

	// Terrarium encodes height as (R * 256 + G + B / 256) - 32768 metres.
	const data = ctx.getImageData( 0, 0, w, h ).data;
	const heightAt = ( x, y ) => {
		x = Math.min( Math.max( x, 0 ), w - 1 );
		y = Math.min( Math.max( y, 0 ), h - 1 );
		const o = ( y * w + x ) * 4;
		return data[ o ] * 256 + data[ o + 1 ] + data[ o + 2 ] / 256 - 32768;
	};

	const sample = ( lat, lon ) => {
		const x = px( lon ) - tx0 * 256 - .5, y = py( lat ) - ty0 * 256 - .5;
		const x0 = Math.floor( x ), y0 = Math.floor( y ), fx = x - x0, fy = y - y0;
		const a = heightAt( x0, y0 ) * ( 1 - fx ) + heightAt( x0 + 1, y0 ) * fx;
		const b = heightAt( x0, y0 + 1 ) * ( 1 - fx ) + heightAt( x0 + 1, y0 + 1 ) * fx;
		return a * ( 1 - fy ) + b * fy;
	};
	return { heights: Float32Array.from( lats, ( lat, i ) => sample( lat, lons[ i ] ) ), sample };
}
