import {
	Color,
	FrontSide,
	HalfFloatType,
	Matrix4,
	Mesh,
	PerspectiveCamera,
	ShaderMaterial,
	UniformsLib,
	UniformsUtils,
	Vector2,
	Vector3,
	WebGLRenderTarget
} from 'three';

const _screenSize = new Vector2();

/**
 * A basic flat, reflective water effect.
 *
 * Note that this class can only be used with {@link WebGLRenderer}.
 * When using {@link WebGPURenderer}, use {@link WaterMesh}.
 *
 * References:
 *
 * - [Flat mirror for three.js](https://github.com/Slayvin)
 * - [An implementation of water shader based on the flat mirror](https://home.adelphi.edu/~stemkoski/)
 * - [Water shader explanations in WebGL](http://29a.ch/slides/2012/webglwater/ )
 *
 * @augments Mesh
 * @three_import import { Water } from 'three/addons/objects/Water.js';
 */
class Water extends Mesh {

	/**
	 * Constructs a new water instance.
	 *
	 * @param {BufferGeometry} geometry - The water's geometry.
	 * @param {Water~Options} [options] - The configuration options.
	 */
	constructor( geometry, options = {} ) {

		super( geometry );

		/**
		 * This flag can be used for type testing.
		 *
		 * @type {boolean}
		 * @readonly
		 * @default true
		 */
		this.isWater = true;

		const scope = this;

		const textureWidth = options.textureWidth !== undefined ? options.textureWidth : 512;
		const textureHeight = options.textureHeight !== undefined ? options.textureHeight : 512;

		const alpha = options.alpha !== undefined ? options.alpha : 1.0;
		const time = options.time !== undefined ? options.time : 0.0;
		const normalSampler = options.waterNormals !== undefined ? options.waterNormals : null;
		const sunDirection = options.sunDirection !== undefined ? options.sunDirection : new Vector3( 0.70707, 0.70707, 0.0 );
		const sunColor = new Color( options.sunColor !== undefined ? options.sunColor : 0xffffff );
		const waterColor = new Color( options.waterColor !== undefined ? options.waterColor : 0x7F7F7F );
		const eye = options.eye !== undefined ? options.eye : new Vector3( 0, 0, 0 );
		const distortionScale = options.distortionScale !== undefined ? options.distortionScale : 20.0;
		const reflectivity = options.reflectivity !== undefined ? options.reflectivity : 0.22;
		const reflectionY = options.reflectionY;
		const side = options.side !== undefined ? options.side : FrontSide;
		const fog = options.fog !== undefined ? options.fog : false;
		const waterFadeColor = new Color( options.waterFadeColor !== undefined ? options.waterFadeColor : 0xffffff );
		const waterFadeStart = options.waterFadeStart !== undefined ? options.waterFadeStart : 1e9;
		const waterFadeEnd = options.waterFadeEnd !== undefined ? options.waterFadeEnd : 1e9;

		//

		const normal = new Vector3();
		const mirrorWorldPosition = new Vector3();
		const cameraWorldPosition = new Vector3();
		const rotationMatrix = new Matrix4();
		const lookAtPosition = new Vector3( 0, 0, - 1 );

		const view = new Vector3();
		const target = new Vector3();

		const mirrorCamera = new PerspectiveCamera();

		const renderTarget = new WebGLRenderTarget( textureWidth, textureHeight, { type: HalfFloatType } );

		// Exposed so the owner can dispose the GPU resources with the mesh.
		this.renderTarget = renderTarget;

		const mirrorShader = {

			name: 'MirrorShader',

			uniforms: UniformsUtils.merge( [
				UniformsLib[ 'fog' ],
				UniformsLib[ 'lights' ],
				{
					'normalSampler': { value: null },
					'mirrorSampler': { value: null },
					'alpha': { value: 1.0 },
					'time': { value: 0.0 },
					'size': { value: 1.0 },
					'distortionScale': { value: 20.0 },
					'screenSize': { value: new Vector2( 1, 1 ) },
					'sunColor': { value: new Color( 0x7F7F7F ) },
					'sunDirection': { value: new Vector3( 0.70707, 0.70707, 0 ) },
					'eye': { value: new Vector3() },
					'waterColor': { value: new Color( 0x555555 ) },
					'waterFadeColor': { value: new Color( 0xffffff ) },
					'waterFadeStart': { value: 1e9 },
					'waterFadeEnd': { value: 1e9 }
				}
			] ),

			vertexShader: /* glsl */`
				uniform float time;

				varying vec4 worldPosition;

				#include <common>
				#include <fog_pars_vertex>
				#include <shadowmap_pars_vertex>
				#include <logdepthbuf_pars_vertex>

				void main() {
					worldPosition = modelMatrix * vec4( position, 1.0 );
					vec4 mvPosition =  modelViewMatrix * vec4( position, 1.0 );
					gl_Position = projectionMatrix * mvPosition;

				#include <beginnormal_vertex>
				#include <defaultnormal_vertex>
				#include <logdepthbuf_vertex>
				#include <fog_vertex>
				#include <shadowmap_vertex>
			}`,

			fragmentShader: /* glsl */`
				uniform sampler2D mirrorSampler;
				uniform float alpha;
				uniform float time;
				uniform float size;
				uniform float distortionScale;
				uniform sampler2D normalSampler;
				uniform vec3 sunColor;
				uniform vec3 sunDirection;
				uniform vec3 eye;
				uniform vec3 waterColor;
				uniform vec3 waterFadeColor;
				uniform float waterFadeStart;
				uniform float waterFadeEnd;
				uniform vec2 screenSize;

				varying vec4 worldPosition;

				vec4 getNoise( vec2 uv ) {
					vec2 uv0 = ( uv / 103.0 ) + vec2(time / 17.0, time / 29.0);
					vec2 uv1 = uv / 107.0-vec2( time / -19.0, time / 31.0 );
					vec2 uv2 = uv / vec2( 8907.0, 9803.0 ) + vec2( time / 101.0, time / 97.0 );
					vec2 uv3 = uv / vec2( 1091.0, 1027.0 ) - vec2( time / 109.0, time / -113.0 );
					vec4 noise = texture2D( normalSampler, uv0 ) +
						texture2D( normalSampler, uv1 ) +
						texture2D( normalSampler, uv2 ) +
						texture2D( normalSampler, uv3 );
					return noise * 0.5 - 1.0;
				}

				void sunLight( const vec3 surfaceNormal, const vec3 eyeDirection, float shiny, float spec, float diffuse, inout vec3 diffuseColor, inout vec3 specularColor ) {
					vec3 reflection = normalize( reflect( -sunDirection, surfaceNormal ) );
					float direction = max( 0.0, dot( eyeDirection, reflection ) );
					specularColor += pow( direction, shiny ) * sunColor * spec;
					diffuseColor += max( dot( sunDirection, surfaceNormal ), 0.0 ) * sunColor * diffuse;
				}

				#include <common>
				#include <packing>
				#include <bsdfs>
				#include <fog_pars_fragment>
				#include <logdepthbuf_pars_fragment>
				#include <lights_pars_begin>
				#include <shadowmap_pars_fragment>
				#include <shadowmask_pars_fragment>

				void main() {

					#include <logdepthbuf_fragment>
					vec4 noise = getNoise( worldPosition.xz * size );
					vec3 surfaceNormal = normalize( noise.xzy * vec3( 1.5, 1.0, 1.5 ) );

					vec3 diffuseLight = vec3(0.0);
					vec3 specularLight = vec3(0.0);

					vec3 worldToEye = eye-worldPosition.xyz;
					vec3 eyeDirection = normalize( worldToEye );
					sunLight( surfaceNormal, eyeDirection, 100.0, 2.0, 0.5, diffuseLight, specularLight );

					float distance = length(worldToEye);

					vec2 distortion = surfaceNormal.xz * ( 0.001 + 1.0 / distance ) * distortionScale;
					vec2 screenUv = gl_FragCoord.xy / screenSize;
					vec2 sampleUv = vec2( 1.0 - screenUv.x, screenUv.y ) + distortion;

					// Smear the reflection down the screen with a small vertical
					// kernel: still water but noticeably soft and stretched.
					vec3 reflectionSample = vec3( 0.0 );
					float reflectionWeight = 0.0;
					for ( int i = -4; i <= 4; i ++ ) {
						float fi = float( i );
						float weight = 1.0 - abs( fi ) * 0.18;
						vec2 tap = sampleUv + vec2( fi * 0.0007, fi * 0.0085 );
						reflectionSample += texture2D( mirrorSampler, tap ).rgb * weight;
						reflectionWeight += weight;
					}
					reflectionSample /= reflectionWeight;

					float theta = max( dot( eyeDirection, surfaceNormal ), 0.0 );
					float rf0 = ${ reflectivity.toFixed( 2 ) };
					float reflectance = rf0 + ( 1.0 - rf0 ) * pow( ( 1.0 - theta ), 5.0 );
					vec3 scatter = max( 0.0, dot( surfaceNormal, eyeDirection ) ) * waterColor;
					vec3 albedo = mix( ( sunColor * diffuseLight * 0.3 + scatter ) * getShadowMask(), reflectionSample + specularLight, reflectance );
					vec3 outgoingLight = albedo;

					// Flat-map horizon: dissolve the far ocean into the sky instead
					// of letting the sheet run to the edge of the view.
					float waterFade = smoothstep( waterFadeStart, waterFadeEnd, length( worldPosition.xz ) );
					outgoingLight = mix( outgoingLight, waterFadeColor, waterFade );

					gl_FragColor = vec4( outgoingLight, alpha );

					#include <tonemapping_fragment>
					#include <colorspace_fragment>
					#include <fog_fragment>
				}`

		};

		const material = new ShaderMaterial( {
			name: mirrorShader.name,
			uniforms: UniformsUtils.clone( mirrorShader.uniforms ),
			vertexShader: mirrorShader.vertexShader,
			fragmentShader: mirrorShader.fragmentShader,
			lights: true,
			side: side,
			fog: fog
		} );

		material.uniforms[ 'mirrorSampler' ].value = renderTarget.texture;
		material.uniforms[ 'alpha' ].value = alpha;
		material.uniforms[ 'time' ].value = time;
		material.uniforms[ 'normalSampler' ].value = normalSampler;
		material.uniforms[ 'sunColor' ].value = sunColor;
		material.uniforms[ 'waterColor' ].value = waterColor;
		material.uniforms[ 'sunDirection' ].value = sunDirection;
		material.uniforms[ 'distortionScale' ].value = distortionScale;
		material.uniforms[ 'waterFadeColor' ].value = waterFadeColor;
		material.uniforms[ 'waterFadeStart' ].value = waterFadeStart;
		material.uniforms[ 'waterFadeEnd' ].value = waterFadeEnd;

		material.uniforms[ 'eye' ].value = eye;

		scope.material = material;

		scope.onBeforeRender = function ( renderer, scene, camera ) {

			// The reflection is deliberately soft, so half the refresh rate is
			// invisible and saves a full scene render every other frame.
			scope.userData.waterReflectionFrame =
				( scope.userData.waterReflectionFrame || 0 ) + 1;
			if ( ( scope.userData.waterReflectionFrame & 1 ) === 0 ) return;

			mirrorWorldPosition.setFromMatrixPosition( scope.matrixWorld );
			if ( reflectionY !== undefined ) mirrorWorldPosition.y = reflectionY;
			cameraWorldPosition.setFromMatrixPosition( camera.matrixWorld );

			rotationMatrix.extractRotation( scope.matrixWorld );

			normal.set( 0, 0, 1 );
			normal.applyMatrix4( rotationMatrix );

			view.subVectors( mirrorWorldPosition, cameraWorldPosition );

			// Avoid rendering when mirror is facing away

			if ( view.dot( normal ) > 0 ) return;

			view.reflect( normal ).negate();
			view.add( mirrorWorldPosition );

			rotationMatrix.extractRotation( camera.matrixWorld );

			lookAtPosition.set( 0, 0, - 1 );
			lookAtPosition.applyMatrix4( rotationMatrix );
			lookAtPosition.add( cameraWorldPosition );

			target.subVectors( mirrorWorldPosition, lookAtPosition );
			target.reflect( normal ).negate();
			target.add( mirrorWorldPosition );

			mirrorCamera.position.copy( view );
			mirrorCamera.up.set( 0, 1, 0 );
			mirrorCamera.up.applyMatrix4( rotationMatrix );
			mirrorCamera.up.reflect( normal );
			mirrorCamera.lookAt( target );

			mirrorCamera.far = camera.far; // Used in WebGLBackground

			mirrorCamera.updateMatrixWorld();
			mirrorCamera.projectionMatrix.copy( camera.projectionMatrix );

			// Screen-space reflection sampling; the addon's oblique clip is
			// invalid for an orthographic camera. There is no geometry below the
			// water plane, so the mirror view can be rendered unclipped.
			const drawingBufferSize = renderer.getDrawingBufferSize( _screenSize );
			material.uniforms[ 'screenSize' ].value.copy( drawingBufferSize );

			eye.setFromMatrixPosition( camera.matrixWorld );

			// Render

			const currentRenderTarget = renderer.getRenderTarget();

			const currentXrEnabled = renderer.xr.enabled;
			const currentShadowAutoUpdate = renderer.shadowMap.autoUpdate;

			scope.visible = false;

			renderer.xr.enabled = false; // Avoid camera modification and recursion
			renderer.shadowMap.autoUpdate = false; // Avoid re-computing shadows

			renderer.setRenderTarget( renderTarget );

			renderer.state.buffers.depth.setMask( true ); // make sure the depth buffer is writable so it can be properly cleared, see #18897

			if ( renderer.autoClear === false ) renderer.clear();
			renderer.render( scene, mirrorCamera );

			scope.visible = true;

			renderer.xr.enabled = currentXrEnabled;
			renderer.shadowMap.autoUpdate = currentShadowAutoUpdate;

			renderer.setRenderTarget( currentRenderTarget );

			// Restore viewport

			const viewport = camera.viewport;

			if ( viewport !== undefined ) {

				renderer.state.viewport( viewport );

			}

		};

	}

}

/**
 * Constructor options of `Water`.
 *
 * @typedef {Object} Water~Options
 * @property {number} [textureWidth=512] - The texture width. A higher value results in more clear reflections but is also more expensive.
 * @property {number} [textureHeight=512] - The texture height. A higher value results in more clear reflections but is also more expensive.
 * @property {number} [clipBias=0] - The clip bias.
 * @property {number} [alpha=1] - The alpha value.
 * @property {number} [time=0] - The time value.
 * @property {?Texture} [waterNormals=null] - The water's normal map.
 * @property {Vector3} [sunDirection=(0.70707,0.70707,0.0)] - The sun direction.
 * @property {number|Color|string} [sunColor=0xffffff] - The sun color.
 * @property {number|Color|string} [waterColor=0x7F7F7F] - The water color.
 * @property {Vector3} [eye] - The eye vector.
 * @property {number} [distortionScale=20] - The distortion scale.
 * @property {(FrontSide|BackSide|DoubleSide)} [side=FrontSide] - The water material's `side` property.
 * @property {boolean} [fog=false] - Whether the water should be affected by fog or not.
 **/

export { Water };
