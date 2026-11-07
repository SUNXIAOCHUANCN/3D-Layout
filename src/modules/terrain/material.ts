import { Color, DataTexture, LinearFilter, LinearMipmapLinearFilter, MeshStandardMaterial, RepeatWrapping, RGBAFormat, Vector2, Vector4 } from 'three'
import type { TerrainSurface, TerrainMaterialResource } from '../../core/types'
import { PRESETS } from './surface'

// Deterministic periodic detail textures, generated locally without network assets.
function detailTexture(preset: keyof typeof PRESETS, tint?: string) {
  const size = 128, data = new Uint8Array(size * size * 4)
  const color = new Color(tint ?? PRESETS[preset].color)
  const height = (x: number, y: number) => {
    const wave = (f: number, a: number, b: number) => Math.sin((x * a + y * b) / size * Math.PI * 2 * f)
    const grain = ((Math.imul(x, 374761393) ^ Math.imul(y, 668265263)) >>> 0) % 1024 / 1024
    if (preset === 'grass') return 0.5 + 0.18 * wave(12, 1, 3) + grain * 0.25
    if (preset === 'sand') return 0.55 + 0.12 * wave(4, 1, 2) + grain * 0.12
    if (preset === 'rock') return 0.5 + 0.2 * wave(3, 2, 1) * wave(5, 1, -1) + grain * 0.2
    return 0.7 + 0.06 * wave(3, 1, 2) + grain * 0.08
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4, h = height(x, y), brightness = 0.75 + h * 0.35
    data[i] = Math.min(255, color.r * brightness * 255)
    data[i + 1] = Math.min(255, color.g * brightness * 255)
    data[i + 2] = Math.min(255, color.b * brightness * 255)
    data[i + 3] = h * 255
  }
  const texture = new DataTexture(data, size, size, RGBAFormat)
  texture.wrapS = texture.wrapT = RepeatWrapping
  texture.magFilter = LinearFilter; texture.minFilter = LinearMipmapLinearFilter
  texture.generateMipmaps = true; texture.needsUpdate = true
  return texture
}

const srgb = Array.from({ length: 256 }, (_, i) => Math.round((i / 255 <= 0.04045 ? i / 255 / 12.92 : ((i / 255 + 0.055) / 1.055) ** 2.4) * 255))
async function pixels(path: string, size: number) {
  const response = await fetch(path)
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
  const blob = await response.blob()
  if (blob.size > 20 * 1024 * 1024) throw new Error(`${path}: 图片超过 20MB`)
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
  try {
    if (bitmap.width > 8192 || bitmap.height > 8192) throw new Error(`${path}: 图片尺寸超过 8192`)
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = size
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0, size, size)
    return ctx.getImageData(0, 0, size, size).data
  } finally { bitmap.close() }
}
function dataTexture(data: Uint8Array, size: number) {
  const t = new DataTexture(data, size, size, RGBAFormat)
  t.wrapS = t.wrapT = RepeatWrapping; t.magFilter = LinearFilter; t.minFilter = LinearMipmapLinearFilter
  t.generateMipmaps = true; t.needsUpdate = true
  return t
}
export function createSurfaceMaterial(surface: TerrainSurface, _width: number, _depth: number) {
  const m = surface.weightMap
  const weights = new DataTexture(new Uint8Array(m.data), m.width, m.height, RGBAFormat)
  weights.magFilter = weights.minFilter = LinearFilter; weights.needsUpdate = true
  let disposed = false
  const errors: string[] = []
  const jobs: Promise<void>[] = []
  const imageCache = new Map<string, ReturnType<typeof pixels>>()
  const loadPixels = (path: string) => {
    let pending = imageCache.get(path)
    if (!pending) { pending = pixels(path, 512); imageCache.set(path, pending) }
    return pending
  }
  const layers = Array.from({ length: 4 }, (_, i) => {
    const l = surface.layers[i] ?? surface.layers[0]
    const resource = surface.materials?.find(r => r.id === l.materialId)
    const preset = l.presetId ?? 'grass'
    const roughness = l.roughness ?? resource?.roughness ?? (resource ? 0.8 : PRESETS[preset].roughness)
    const strength = l.normalStrength ?? resource?.normalStrength ?? 1
    const albedo = resource ? dataTexture(new Uint8Array([255, 255, 255, 255]), 1) : detailTexture(preset, l.tint)
    const normal = dataTexture(new Uint8Array([128, 128, 255, 255]), 1)
    const detail = resource ? dataTexture(new Uint8Array([255, 255, 128, 255]), 1) : (() => {
      const bytes = albedo.image.data as Uint8Array, out = new Uint8Array(bytes.length)
      for (let j = 0; j < out.length; j += 4) { out[j] = 255; out[j + 1] = 255; out[j + 2] = bytes[j + 3]; out[j + 3] = 255; bytes[j + 3] = 255 }
      return dataTexture(out, 128)
    })()
    const tint = resource ? new Color(resource.color ?? '#ffffff').multiply(new Color(l.tint ?? '#ffffff')) : new Color('#ffffff')
    if (resource && Object.keys(resource.maps ?? {}).length) {
      const r: TerrainMaterialResource = resource
      jobs.push((async () => {
        try {
          const size = 512
          const entries = await Promise.all(Object.entries(r.maps ?? {}).map(async ([key, path]) => [key, await loadPixels(path)] as const))
          const maps = Object.fromEntries(entries)
          if (disposed) return
          const a = new Uint8Array(size * size * 4), n = new Uint8Array(a.length), d = new Uint8Array(a.length)
          for (let j = 0; j < a.length; j += 4) {
            for (let c = 0; c < 3; c++) a[j + c] = maps.color ? srgb[maps.color[j + c]] : 255
            a[j + 3] = 255
            n[j] = maps.normal?.[j] ?? 128; n[j + 1] = maps.normal?.[j + 1] ?? 128; n[j + 2] = maps.normal?.[j + 2] ?? 255; n[j + 3] = 255
            d[j] = maps.roughness?.[j] ?? 255; d[j + 1] = maps.ao?.[j] ?? 255; d[j + 2] = maps.height?.[j] ?? 128; d[j + 3] = 255
          }
          for (const [texture, data] of [[albedo, a], [normal, n], [detail, d]] as const) {
            texture.image = { data, width: size, height: size }; texture.needsUpdate = true
          }
        } catch (e) { if (!disposed) { errors.push(e instanceof Error ? e.message : String(e)); console.error('地形材质加载失败', e) } }
      })())
    }
    return { albedo, normal, detail, roughness, strength, tint, tileSize: l.tileSize }
  })
  const vec = (fn: (l: typeof layers[number]) => number) => new Vector4(...layers.map(fn) as [number, number, number, number])
  const blend = surface.blend
  const material = new MeshStandardMaterial({ roughness: 1, metalness: 0 })
  material.userData.surfaceErrors = errors
  material.customProgramCacheKey = () => 'terrain-surface-v2'
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, {
      surfaceWeights: { value: weights }, weightSize: { value: new Vector2(m.width, m.height) },
      surfaceScales: { value: vec(l => l.tileSize) }, surfaceRoughness: { value: vec(l => l.roughness) }, normalStrengths: { value: vec(l => l.strength) },
      blendSettings: { value: new Vector4(blend?.mode === 'height' ? blend.heightContrast ?? 4 : 0, blend?.noiseStrength ?? 0, blend?.noiseScale ?? 2, blend?.seed ?? 0) },
    })
    layers.forEach((l, i) => {
      shader.uniforms[`surfaceMap${i}`] = { value: l.albedo }
      shader.uniforms[`surfaceNormal${i}`] = { value: l.normal }
      shader.uniforms[`surfaceDetail${i}`] = { value: l.detail }
      shader.uniforms[`surfaceTint${i}`] = { value: l.tint }
    })
    shader.vertexShader = 'varying vec2 vSurfaceUv; varying vec2 vSurfaceXZ;\n' + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvSurfaceUv = uv; vSurfaceXZ = position.xz;')
    shader.fragmentShader = `
      varying vec2 vSurfaceUv; varying vec2 vSurfaceXZ;
      uniform sampler2D surfaceWeights;
      uniform vec2 weightSize;
      uniform vec4 surfaceScales; uniform vec4 surfaceRoughness; uniform vec4 normalStrengths; uniform vec4 blendSettings;
      ${layers.map((_, i) => `uniform sampler2D surfaceMap${i}; uniform sampler2D surfaceNormal${i}; uniform sampler2D surfaceDetail${i}; uniform vec3 surfaceTint${i};`).join('\n')}
      float surfaceHash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7)) + blendSettings.w * 0.001) * 43758.5453); }
      float surfaceNoise(vec2 p) {
        vec2 a = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(surfaceHash(a), surfaceHash(a + vec2(1,0)), f.x), mix(surfaceHash(a + vec2(0,1)), surfaceHash(a + vec2(1,1)), f.x), f.y);
      }
    ` + shader.fragmentShader
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
      vec2 weightUv = (vSurfaceUv * (weightSize - 1.0) + 0.5) / weightSize;
      vec4 sw = texture2D(surfaceWeights, weightUv);
      ${layers.map((_, i) => `
        vec2 suv${i} = vSurfaceXZ / surfaceScales[${i}];
        vec3 color${i} = texture2D(surfaceMap${i}, suv${i}).rgb * surfaceTint${i};
        vec3 detail${i} = texture2D(surfaceDetail${i}, suv${i}).rgb;
        vec3 norm${i} = texture2D(surfaceNormal${i}, suv${i}).xyz * 2.0 - 1.0;
        norm${i}.xy *= normalStrengths[${i}]; norm${i} = normalize(norm${i});
      `).join('\n')}
      vec4 heightWeights = vec4(detail0.b, detail1.b, detail2.b, detail3.b);
      vec2 np = vSurfaceXZ / blendSettings.z;
      vec4 noiseWeights = vec4(surfaceNoise(np), surfaceNoise(np + 17.3), surfaceNoise(np + 43.7), surfaceNoise(np + 91.1)) - 0.5;
      // Multiplication preserves absent layers and bounds contrast to painted overlaps.
      sw *= exp2((heightWeights - 0.5) * blendSettings.x + noiseWeights * blendSettings.y * 4.0);
      sw /= max(dot(sw, vec4(1.0)), 0.00001);
      diffuseColor.rgb *= color0 * sw.x + color1 * sw.y + color2 * sw.z + color3 * sw.w;
    `)
    shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', `
      #include <roughnessmap_fragment>
      roughnessFactor = dot(sw, surfaceRoughness * vec4(detail0.r, detail1.r, detail2.r, detail3.r));
    `)
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `
      #include <normal_fragment_maps>
      vec3 sx = dFdx(-vViewPosition), sy = dFdy(-vViewPosition);
      vec2 ux = dFdx(vSurfaceXZ), uy = dFdy(vSurfaceXZ);
      float uvDet = ux.x * uy.y - ux.y * uy.x;
      vec3 mappedNormal = normalize(norm0 * sw.x + norm1 * sw.y + norm2 * sw.z + norm3 * sw.w);
      if (abs(uvDet) > 0.00000001) {
        vec3 tangent = (sx * uy.y - sy * ux.y) / uvDet;
        vec3 bitangent = (-sx * uy.x + sy * ux.x) / uvDet;
        tangent = normalize(tangent - normal * dot(normal, tangent));
        bitangent = normalize(bitangent - normal * dot(normal, bitangent) - tangent * dot(tangent, bitangent));
        normal = normalize(tangent * mappedNormal.x + bitangent * mappedNormal.y + normal * mappedNormal.z);
      }
      float dhx = dot(vec4(dFdx(detail0.b), dFdx(detail1.b), dFdx(detail2.b), dFdx(detail3.b)) * normalStrengths, sw) * 0.035;
      float dhy = dot(vec4(dFdy(detail0.b), dFdy(detail1.b), dFdy(detail2.b), dFdy(detail3.b)) * normalStrengths, sw) * 0.035;
      vec3 r1 = cross(sy, normal), r2 = cross(normal, sx);
      float determinant = dot(sx, r1);
      if (abs(determinant) > 0.00000001) normal = normalize(abs(determinant) * normal - sign(determinant) * (dhx * r1 + dhy * r2));
    `)
    shader.fragmentShader = shader.fragmentShader.replace('#include <aomap_fragment>', `
      #include <aomap_fragment>
      float surfaceAO = dot(sw, vec4(detail0.g, detail1.g, detail2.g, detail3.g));
      reflectedLight.indirectDiffuse *= surfaceAO;
      reflectedLight.indirectSpecular *= surfaceAO;
    `)
  }
  return { material, errors, ready: Promise.all(jobs).then(() => { material.userData.surfaceReady = !disposed }), dispose() { disposed = true; material.dispose(); weights.dispose(); layers.forEach(l => { l.albedo.dispose(); l.normal.dispose(); l.detail.dispose() }) } }
}
