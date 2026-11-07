import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Color, HalfFloatType, Mesh, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, Scene, Vector4, type WebGLRenderer } from 'three'
import { engine, registerBridge, type CaptureCamera } from '../../../core/engine'
const output = vi.hoisted(() => ({ render: vi.fn(), dispose: vi.fn() }))
vi.mock('three/examples/jsm/postprocessing/OutputPass.js', () => ({ OutputPass: class { render = output.render; dispose = output.dispose } }))
const camera: CaptureCamera = { projection: 'orthographic', position: [0, 10, 0], target: [0, 0, 0], up: [0, 0, -1], viewHeight: 10, near: .1, far: 100 }
let scene: Scene, mesh: Mesh, shared: Mesh, helper: Mesh, material: MeshStandardMaterial, renderer: ReturnType<typeof fakeRenderer>, encoded: Uint8ClampedArray
function fakeRenderer() {
  const initial = { name: 'existing render target' }
  return {
    initial, capabilities: { maxSamples: 4 }, autoClear: false, xr: { enabled: true },
    getRenderTarget: () => initial, getActiveCubeFace: () => 2, getActiveMipmapLevel: () => 3,
    getViewport: (v: Vector4) => v.set(3, 4, 5, 6), getScissor: (v: Vector4) => v.set(7, 8, 9, 10), getScissorTest: () => true,
    getClearColor: (c: Color) => c.set('#123456'), getClearAlpha: () => .7, setClearColor: vi.fn(),
    setRenderTarget: vi.fn(), setViewport: vi.fn(), setScissor: vi.fn(), setScissorTest: vi.fn(), render: vi.fn(),
    readRenderTargetPixels: vi.fn((_target, _x, _y, _w, _h, pixels: Uint8Array) => { for (let i = 0; i < pixels.length; i++) pixels[i] = i }),
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  renderer = fakeRenderer(); scene = new Scene(); material = new MeshStandardMaterial({ roughness: .067, color: '#004d71' })
  mesh = new Mesh(new PlaneGeometry(), material); shared = new Mesh(mesh.geometry, material)
  helper = new Mesh(); helper.userData.editorHelper = true
  scene.add(mesh, shared, helper)
  registerBridge({ gl: renderer as unknown as WebGLRenderer, scene, camera: new PerspectiveCamera(), controls: null })
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ({ createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: (image: { data: Uint8ClampedArray }) => { encoded = image.data } }), toDataURL: () => 'data:image/png;base64,test' }) })
})
afterEach(() => { registerBridge(null); vi.unstubAllGlobals() })
it('renders unclipped HDR through the renderer output pass and flips readback rows', () => {
  engine.captureFromCamera(camera, 2, 2)
  const linear = renderer.setRenderTarget.mock.calls[0][0]
  expect(linear.texture.type).toBe(HalfFloatType)
  expect(linear.samples).toBe(4)
  expect(output.render).toHaveBeenCalledWith(renderer, expect.anything(), linear, 0, false)
  expect(encoded.slice(0, 8)).toEqual(new Uint8ClampedArray([8, 9, 10, 11, 12, 13, 14, 15]))
  expect(renderer.setRenderTarget).toHaveBeenLastCalledWith(renderer.initial, 2, 3)
  expect(renderer.setViewport).toHaveBeenLastCalledWith(new Vector4(3, 4, 5, 6))
  expect(renderer.setScissor).toHaveBeenLastCalledWith(new Vector4(7, 8, 9, 10))
  expect(renderer.setScissorTest).toHaveBeenLastCalledWith(true)
  expect(renderer.setClearColor).toHaveBeenLastCalledWith(new Color('#123456'), .7)
  expect(renderer.autoClear).toBe(false); expect(renderer.xr.enabled).toBe(true)
})
it('stabilizes reflections with temporary shared material clones only for an analysis capture', () => {
  let temporary: MeshStandardMaterial | undefined
  const originalDispose = vi.spyOn(material, 'dispose')
  renderer.render.mockImplementation(() => {
    temporary = mesh.material as MeshStandardMaterial
    expect(temporary).not.toBe(material)
    expect(temporary.roughness).toBe(.65)
    expect(shared.material).toBe(temporary)
    expect(material.roughness).toBe(.067)
    expect(helper.visible).toBe(false)
  })
  engine.captureFromCamera(camera, 2, 2, { minRoughness: .65 })
  expect(mesh.material).toBe(material); expect(shared.material).toBe(material)
  expect(helper.visible).toBe(true); expect(originalDispose).not.toHaveBeenCalled()
})
it('restores materials, helpers and GPU state even when rendering fails', () => {
  renderer.render.mockImplementation(() => { throw new Error('GPU failure') })
  expect(() => engine.captureFromCamera(camera, 2, 2, { minRoughness: .65 })).toThrow('GPU failure')
  expect(mesh.material).toBe(material); expect(helper.visible).toBe(true)
  expect(renderer.autoClear).toBe(false); expect(renderer.xr.enabled).toBe(true)
  expect(renderer.setRenderTarget).toHaveBeenLastCalledWith(renderer.initial, 2, 3)
  expect(output.dispose).toHaveBeenCalledOnce()
})
it('keeps authored material appearance when no analysis option is requested', () => {
  renderer.render.mockImplementation(() => { expect(mesh.material).toBe(material); expect(material.roughness).toBe(.067) })
  engine.captureFromCamera(camera, 2, 2)
  expect(material.roughness).toBe(.067)
})
it('encodes model-facing captures as jpeg at the requested quality, and stays png by default', () => {
  const toDataURL = vi.fn(() => 'data:image/jpeg;base64,test')
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ({ createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: () => {} }), toDataURL }) })
  expect(engine.captureFromCamera(camera, 2, 2, { format: 'jpeg', quality: 0.8 })).toBe('data:image/jpeg;base64,test')
  expect(toDataURL).toHaveBeenCalledWith('image/jpeg', 0.8)
  expect(() => engine.captureFromCamera(camera, 2, 2, { format: 'jpeg', quality: 2 })).toThrow('截图质量须为 0.1–1')
  engine.captureFromCamera(camera, 2, 2)
  expect(toDataURL).toHaveBeenLastCalledWith('image/png')
})
