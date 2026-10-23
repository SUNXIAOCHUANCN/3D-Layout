import type { ModelManifest, SceneDocument, SceneIndexEntry, ViewBinding } from './types'

const fetchJson = async <T>(url: string): Promise<T> => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

export const loadManifest = () => fetchJson<ModelManifest>('/assets/models/manifest.json')

export const loadSceneIndex = () => fetchJson<SceneIndexEntry[]>('/scenes/index.json')

export const loadSceneDocument = (sceneId: string) =>
  fetchJson<SceneDocument>(`/scenes/${sceneId}/scene.json`)

/** threejs/view.json 是可选的渲染绑定，缺失时返回空对象 */
export const loadViewBinding = async (sceneId: string): Promise<ViewBinding> => {
  try {
    return await fetchJson<ViewBinding>(`/scenes/${sceneId}/threejs/view.json`)
  } catch {
    return {}
  }
}
