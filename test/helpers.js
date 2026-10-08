import fs from 'node:fs';
import zlib from 'node:zlib';

// Walkable streets within 750 m of Fès el Bali, recorded from fetchStreetsFromTiles so tests run offline.
export const FES = { lat: 34.0646, lon: -4.973, radius: 600 };
export const fesElements = () => JSON.parse( zlib.gunzipSync( fs.readFileSync( new URL( './fixtures/fes-750.json.gz', import.meta.url ) ) ) );
