# Urban Arteries

Walking routes from one point out to the edge of the city around it, bundled along the streets they share and
drawn with depth of field. Static files: serve the folder and open `index.html`.

`main.js` only wires the modules in `src/` together. Each module takes plain data and options and returns plain
data, so it can be lifted into another project on its own.

## Modules

| Module | Exports | Needs |
| --- | --- | --- |
| `src/streets/tiles.js` | `fetchStreetsFromTiles( lat, lon, radius, { signal, onProgress } )` — streets from OpenFreeMap vector tiles, re-noded into a routable network | `@mapbox/vector-tile`, `pbf` |
| `src/streets/overpass.js` | `fetchStreetsFromOverpass( lat, lon, radius, { signal, onProgress, endpoints, filter, headers } )` — the same from Overpass, cached | — |
| `src/terrain.js` | `loadTerrain( lats, lons, { zoom, include, signal, onProgress } )` → `{ heights, sample( lat, lon ) }` | browser (OffscreenCanvas) |
| `src/geocode.js` | `geocode( query )` → `{ lat, lon, name }` via Nominatim | — |
| `src/graph/graph.js` | `buildGraph( elements, lat0, lon0, { costs, include } )`, `nearestNode`, `toLatLon`, `HIGHWAY_COST`, `walkable` | — |
| `src/graph/dijkstra.js` | `shortestPathTree( g, source, weight, { turnPenalty, goals } )` | — |
| `src/graph/routes.js` | `route( g, source, { algorithm, radius, count, layout, bundling } )`, `branches`, `toPaths`, `pickTargets`, `seededRandom` | — |
| `src/render/viewer.js` | `createViewer( container )` — renderer, camera, orbit controls, shared uniforms, lens focused on the orbit target | three |
| `src/render/arteries.js` | `createArteries( uniforms )` — paths as lines or particles, growth and pulse animation | three |
| `src/render/strips.js` | `stripGeometry( paths, { step } )`, `createStripMaterial( uniforms )` — MeshLine-style lines with thin-lens defocus | three |
| `src/render/particles.js` | `particleGeometry( paths, { spacing } )`, `createParticleMaterial( uniforms )` | three |
| `src/render/chunks.js` | `createUniforms()`, `defocusGLSL`, `arteryColorGLSL` | three |
| `src/render/marker.js` | `createMarker( uniforms )` | three |
| `src/print/mesh.js` | `tube`, `sphere`, `disc`, `triangles`, `writeSTL` — closed mesh primitives and binary STL | — |
| `src/print/model.js` | `buildPrintModel( paths, { radius, size, exag, base, ground } )` → `{ blob, triangles }` | — |
| `src/ui/progress.js` | `createProgress( element )` | DOM |
| `src/ui/panel.js`, `src/params.js` | this app's guspira panel, settings and presets | guspira |

Street sources return OSM-shaped elements (`{ type: 'node', id, lat, lon }`, `{ type: 'way', nodes, tags }`), so
either feeds `buildGraph`. Routing, rendering and printing meet at **paths**:

```js
{ points: [ [ x, height, z ], … ], dist: [ … ], weight: [ … ] }   // metres, y up; weight 0..1
```

## Headless example

Everything except terrain, rendering and the panel runs in Node:

```js
import { fetchStreetsFromTiles } from './src/streets/tiles.js';
import { buildGraph, nearestNode } from './src/graph/graph.js';
import { route, branches, toPaths } from './src/graph/routes.js';
import { buildPrintModel } from './src/print/model.js';

const [ lat, lon, radius ] = [ 41.387, 2.1701, 1200 ];
const g = buildGraph( await fetchStreetsFromTiles( lat, lon, radius * 1.25 ), lat, lon );
const routes = await route( g, nearestNode( g, 0, 0, g.connected ), { radius } );
const paths = toPaths( g, new Float32Array( g.n ), routes.dist, branches( routes ) );
const { blob } = buildPrintModel( paths, { radius, size: 150, base: 'plate' } );
```

## Credits

Streets © OpenStreetMap contributors, via OpenFreeMap / OpenMapTiles or Overpass. Terrain: AWS Terrain Tiles.
Search: Nominatim.
