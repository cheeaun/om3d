// Fork of three/addons/objects/WaterMesh.js with a configurable Fresnel base
// reflectance and screen-space reflection sampling. The reflection texture is
// rendered by renderGPUWaterReflection(); the stock addon's reflector uses an
// oblique near plane that does not work with this project's orthographic camera.
import { Color, Mesh, Vector3, NodeMaterial } from 'three/webgpu';
import {
  Fn,
  add,
  cameraPosition,
  div,
  normalize,
  positionWorld,
  sub,
  texture,
  vec2,
  max,
  dot,
  reflect,
  pow,
  length,
  float,
  uniform,
  mul,
  mix,
  smoothstep,
  screenUV,
} from 'three/tsl';

class WaterMesh extends Mesh {
  constructor(geometry, options = {}) {
    const material = new NodeMaterial();
    super(geometry, material);

    this.isWaterMesh = true;

    this.waterNormals = texture(options.waterNormals);
    this.alpha = uniform(options.alpha ?? 1.0);
    this.size = uniform(options.size ?? 1.0);
    this.sunColor = uniform(new Color(options.sunColor ?? 0xffffff));
    this.sunDirection = uniform(
      options.sunDirection ?? new Vector3(0.70707, 0.70707, 0.0),
    );
    this.waterColor = uniform(new Color(options.waterColor ?? 0x7f7f7f));
    this.distortionScale = uniform(options.distortionScale ?? 20.0);
    this.reflectivity = options.reflectivity ?? 0.22;
    this.waterFadeColor = uniform(
      new Color(options.waterFadeColor ?? 0xffffff),
    );
    this.waterFadeStart = options.waterFadeStart ?? 1e9;
    this.waterFadeEnd = options.waterFadeEnd ?? 1e9;
    this.reflectionTexture = options.reflectionTexture;

    const getNoise = Fn(([uv]) => {
      // Static normals: the reflection is warped, but the water does not
      // animate.
      const offset = float(0.0);

      const uv0 = add(
        div(uv, 103),
        vec2(div(offset, 17), div(offset, 29)),
      ).toVar();
      const uv1 = div(uv, 107)
        .sub(vec2(div(offset, -19), div(offset, 31)))
        .toVar();
      const uv2 = add(
        div(uv, vec2(8907.0, 9803.0)),
        vec2(div(offset, 101), div(offset, 97)),
      ).toVar();
      const uv3 = sub(
        div(uv, vec2(1091.0, 1027.0)),
        vec2(div(offset, 109), div(offset, -113)),
      ).toVar();

      const sample0 = this.waterNormals.sample(uv0);
      const sample1 = this.waterNormals.sample(uv1);
      const sample2 = this.waterNormals.sample(uv2);
      const sample3 = this.waterNormals.sample(uv3);

      return sample0.add(sample1).add(sample2).add(sample3).mul(0.5).sub(1);
    });

    const noise = getNoise(positionWorld.xz.mul(this.size));
    const surfaceNormal = normalize(noise.xzy.mul(1.5, 1.0, 1.5));

    const worldToEye = cameraPosition.sub(positionWorld);
    const eyeDirection = normalize(worldToEye);

    const reflection = normalize(
      reflect(this.sunDirection.negate(), surfaceNormal),
    );
    const direction = max(0.0, dot(eyeDirection, reflection));
    const specularLight = pow(direction, 100)
      .mul(this.sunColor)
      .mul(2.0);
    const diffuseLight = max(dot(this.sunDirection, surfaceNormal), 0.0)
      .mul(this.sunColor)
      .mul(0.5);

    const distance = length(worldToEye);
    const distortion = surfaceNormal.xz
      .mul(float(0.001).add(float(1.0).div(distance)))
      .mul(this.distortionScale);

    // The water is fully opaque, so keep it in the opaque queue.
    material.transparent = false;
    material.opacityNode = this.alpha;
    material.receivedShadowPositionNode = positionWorld.add(distortion);

    material.colorNode = Fn(() => {
      const baseUv = add(
        vec2(float(1.0).sub(screenUV.x), screenUV.y),
        distortion,
      );

      // Smear the reflection down the screen with a small vertical kernel.
      let reflection = null;
      let reflectionWeight = 0;
      for (let i = -4; i <= 4; i++) {
        const weight = 1 - Math.abs(i) * 0.18;
        const sampler = texture(this.reflectionTexture);
        sampler.uvNode = add(
          baseUv,
          vec2(i * 0.0007, i * 0.0085),
        );
        const contribution = sampler.rgb.mul(weight);
        reflection =
          reflection === null ? contribution : add(reflection, contribution);
        reflectionWeight += weight;
      }
      const reflectionColor = reflection.div(reflectionWeight);

      const theta = max(dot(eyeDirection, surfaceNormal), 0.0);
      const rf0 = float(this.reflectivity);
      const reflectance = mul(
        pow(float(1.0).sub(theta), 5.0),
        float(1.0).sub(rf0),
      ).add(rf0);
      const scatter = max(
        0.0,
        dot(surfaceNormal, eyeDirection),
      ).mul(this.waterColor);
      const waterColorNode = mix(
        this.sunColor.mul(diffuseLight).mul(0.3).add(scatter),
        reflectionColor.add(specularLight),
        reflectance,
      );

      // Flat-map horizon: dissolve the far ocean into the sky instead of
      // letting the sheet run to the edge of the view.
      const fade = smoothstep(
        this.waterFadeStart,
        this.waterFadeEnd,
        length(positionWorld.xz),
      );

      return mix(waterColorNode, this.waterFadeColor, fade);
    })();
  }
}

export { WaterMesh };
