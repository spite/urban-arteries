import { Float32BufferAttribute, BufferGeometry, Vector2, Vector3 } from 'three';

// three's TubeGeometry with a radius that varies along the path: widthCallback( t ) scales `radius` at t in 0..1
// of the path's length. capped closes an open tube with a flat disc at each end, which a printable mesh needs.
class TubeGeometry extends BufferGeometry {

	constructor( path, tubularSegments = 64, radius = 1, radialSegments = 8, closed = false, widthCallback = () => 1, capped = false ) {

		super();
		this.type = 'TubeGeometry';
		this.widthCallback = widthCallback;

		this.parameters = { path, tubularSegments, radius, radialSegments, closed, capped };

		const frames = path.computeFrenetFrames( tubularSegments, closed );

		this.tangents = frames.tangents;
		this.normals = frames.normals;
		this.binormals = frames.binormals;

		const vertex = new Vector3();
		const normal = new Vector3();
		const uv = new Vector2();
		let P = new Vector3();

		const vertices = [];
		const normals = [];
		const uvs = [];
		const indices = [];

		generateBufferData();

		this.setIndex( indices );
		this.setAttribute( 'position', new Float32BufferAttribute( vertices, 3 ) );
		this.setAttribute( 'normal', new Float32BufferAttribute( normals, 3 ) );
		this.setAttribute( 'uv', new Float32BufferAttribute( uvs, 2 ) );

		function generateBufferData() {

			for ( let i = 0; i < tubularSegments; i ++ ) generateSegment( i );

			// Open: a last ring at the end of the path; closed: the first ring again (with different uvs).
			generateSegment( closed === false ? tubularSegments : 0 );

			generateUVs();
			generateIndices();
			if ( capped && ! closed ) generateCaps();

		}

		function generateSegment( i ) {

			P = path.getPointAt( i / tubularSegments, P );

			const N = frames.normals[ i ];
			const B = frames.binormals[ i ];
			const r = widthCallback( i / tubularSegments );

			for ( let j = 0; j <= radialSegments; j ++ ) {

				const v = j / radialSegments * Math.PI * 2;
				const sin = Math.sin( v );
				const cos = - Math.cos( v );

				normal.x = cos * N.x + sin * B.x;
				normal.y = cos * N.y + sin * B.y;
				normal.z = cos * N.z + sin * B.z;
				normal.normalize();
				normals.push( normal.x, normal.y, normal.z );

				vertex.x = P.x + r * radius * normal.x;
				vertex.y = P.y + r * radius * normal.y;
				vertex.z = P.z + r * radius * normal.z;
				vertices.push( vertex.x, vertex.y, vertex.z );

			}

		}

		function generateIndices() {

			for ( let j = 1; j <= tubularSegments; j ++ ) {

				for ( let i = 1; i <= radialSegments; i ++ ) {

					const a = ( radialSegments + 1 ) * ( j - 1 ) + ( i - 1 );
					const b = ( radialSegments + 1 ) * j + ( i - 1 );
					const c = ( radialSegments + 1 ) * j + i;
					const d = ( radialSegments + 1 ) * ( j - 1 ) + i;

					indices.push( a, b, d );
					indices.push( b, c, d );

				}

			}

		}

		function generateUVs() {

			for ( let i = 0; i <= tubularSegments; i ++ ) {

				for ( let j = 0; j <= radialSegments; j ++ ) {

					uv.x = i / tubularSegments;
					uv.y = j / radialSegments;
					uvs.push( uv.x, uv.y );

				}

			}

		}

		// A fan from the path's end point to its end ring, facing back along the path at the start and on at the end.
		function generateCaps() {

			for ( const [ ring, t, facing ] of [ [ 0, 0, - 1 ], [ tubularSegments, 1, 1 ] ] ) {

				const centre = vertices.length / 3;
				path.getPointAt( t, P );
				const T = frames.tangents[ ring ];
				vertices.push( P.x, P.y, P.z );
				normals.push( T.x * facing, T.y * facing, T.z * facing );
				uvs.push( t, .5 );

				const first = ring * ( radialSegments + 1 );
				for ( let j = 0; j < radialSegments; j ++ ) {

					if ( facing < 0 ) indices.push( centre, first + j, first + j + 1 );
					else indices.push( centre, first + j + 1, first + j );

				}

			}

		}

	}

	toJSON() {

		const data = BufferGeometry.prototype.toJSON.call( this );
		data.path = this.parameters.path.toJSON();
		return data;

	}

}

export { TubeGeometry };
