# Urban Arteries

Walking routes from one point out to the edge of the city around it, bundled along the streets they share and
drawn as light through a lens with depth of field. Static files: serve the folder and open `index.html`.

`main.js` only wires the modules in `src/` together. Each module takes plain data and options and returns plain
data, so it can be lifted into another project on its own.

## Modules

**Data** — no DOM; everything but terrain runs in Node.

| Module | Exports |
| --- | --- |
| `src/streets/tiles.js` | `fetchStreetsFromTiles( lat, lon, radius, { signal, onProgress } )` — walkable streets from OpenFreeMap vector tiles, re-noded into a routable network. Needs `@mapbox/vector-tile` and `pbf`. |
| `src/streets/overpass.js` | `fetchStreetsFromOverpass( lat, lon, radius, { signal, onProgress, endpoints, filter, headers } )` — the same from Overpass, cached |
| `src/terrain.js` | `loadTerrain( lats, lons, { zoom, include, signal, onProgress } )` → `{ heights, sample( lat, lon ) }` (browser) |
| `src/geocode.js` | `geocode( query )` → `{ lat, lon, name }` via Nominatim |
| `src/graph/graph.js` | `buildGraph( elements, lat0, lon0, { costs, include } )`, `nearestNode`, `toLatLon`, `HIGHWAY_COST`, `walkable` |
| `src/graph/dijkstra.js` | `shortestPathTree( g, source, weight, { turnPenalty, goals } )` |
| `src/graph/routes.js` | `route( g, source, { algorithm, radius, count, layout, depth, bundling } )`, `branches`, `toPaths`, `toDestinations`, `routeExtent`, `pickDestinations` |
| `src/city.js` | `loadCity( place, { radius, source, signal, onProgress, pause } )` → `{ g, origin, heights, ground }` — streets, graph and terrain in one go |

**Lens** — layered depth of field for anything drawn as light; knows nothing about streets or colours.

| Module | Exports |
| --- | --- |
| `src/lens/uniforms.js` | `createLensUniforms()` — focus, aperture, bokeh rim, band state |
| `src/lens/glsl.js` | `lensGLSL` — `blurRadius( depth )`, `bandWeight( radius )`, `bandPixels( css )`, `bandScreen( clip )` |
| `src/lens/material.js` | `createLensMaterial( lens, { uniforms, vertexShader, fragmentShader } )` |
| `src/lens/layered-pass.js` | `LayeredPass( scene, camera, lens )` — EffectComposer pass: sharp scene into blur bands, each blurred by the aperture at a matching resolution, added up. `configure( { radii, texels, taps, cubic } )` retunes it, `bandRadii()` builds the radii, `bounds` (a `THREE.Sphere`) lets it skip bands nothing can reach, and `debug` shows every band or one, sharp or blurred |

A lens material draws everything sharp, sized with `bandPixels()`, and multiplies its light by
`bandWeight( blurRadius( depth ) )`; the pass does the rest. Because the scene is light that only adds up, the
result is exact apart from the band spacing, and its cost barely depends on how blurred or dense the scene is.

**Rendering and output**

| Module | Exports |
| --- | --- |
| `src/render/viewer.js` | `createViewer( container )` — renderer, scene, orbit camera, lens uniforms; `frame`, `setFov`, `setTilt`, `setLook`, `setBounds`, `setScale`, `setBackground`, `render`, `dispose` |
| `src/render/post.js` | `createPost( renderer, scene, camera, lens )` — layered depth of field → bloom → ACES tone mapping and grain; `FinishPass` |
| `src/render/camera-rig.js` | `createCameraRig( camera, controls )` — framing that fits a disc, lens swaps that keep the subject size, tilt; `fovOf( mm )` |
| `src/render/geometry.js` | `segmentGeometry( paths )`, `particleGeometry( paths )`, `destinationGeometry( destinations )` |
| `src/render/arteries.js` | `createArteries( lens )` — this app's look: lines or particles, destination dots, origin marker, growth and pulse; `bounds` for the depth of field |
| `src/render/adaptive.js` | `createAdaptiveScale( onChange )` — lowers render resolution while frames are slow |
| `src/print/mesh.js` | `tube`, `sphere`, `disc`, `triangles`, `writeSTL` — closed mesh primitives and binary STL |
| `src/print/model.js` | `buildPrintModel( paths, { radius, size, exag, base, ground } )` → `{ blob, triangles }` |
| `src/ui/progress.js`, `src/ui/url.js` | `createProgress( element )`; `writeUrl( query, place )`, `readPlace( hash )` |
| `src/ui/panel.js`, `src/params.js` | this app's guspira panel, settings and presets |

Street sources return OSM-shaped elements (`{ type: 'node', id, lat, lon }`, `{ type: 'way', nodes, tags }`), so
either feeds `buildGraph`. Routing, rendering and printing meet at **paths**:

```js
{ points: [ [ x, height, z ], … ], dist: [ … ], weight: [ … ] }   // metres, y up; weight 0..1
```

## Headless example

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

## Tests

`npm test` runs the offline suite on a recorded street sample (`test/fixtures`): graph, routing, branches, the STL
being closed and to size, share links, adaptive resolution. `npm install` then `npm run test:online` adds the
tile and Overpass sources.

## Credits

Streets © OpenStreetMap contributors, via OpenFreeMap / OpenMapTiles or Overpass. Terrain: AWS Terrain Tiles.
Search: Nominatim.
