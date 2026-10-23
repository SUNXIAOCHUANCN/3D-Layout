/**
 * 极简类型化事件总线。
 * UI、渲染层、编辑器模块与后期 Agent 都从这里感知系统变化（只读侧的解耦点）。
 * 渲染层只上报事实（如 asset:clicked），"谁订阅、订阅后做什么"由各模块决定。
 */

interface EventMap {
  'scene:changed': { sceneId: string | null }
  'asset:selected': { assetId: string | null }
  'asset:loaded': { assetId: string; ref: string }
  'command:dispatched': { type: string }
  'history:changed': Record<string, never>
  'asset:clicked': { assetId: string }
  'viewport:empty-click': Record<string, never>
  'transform:drag-start': { assetId: string }
  'transform:drag-end': { assetId: string }
  /** Agent 视觉点选结果（viewport.pick）：高亮反馈由 agent 模块订阅渲染，不碰选中状态 */
  'agent:picked': { assetId: string | null }
  'scene:saved': { sceneId: string; version: number; mode: 'server' | 'download' }
}

type Handler<K extends keyof EventMap> = (payload: EventMap[K]) => void

class EventBus {
  /** 内部以宽松类型存储，类型安全由公开 API 保证 */
  private handlers = new Map<keyof EventMap, Set<(payload: never) => void>>()

  on<K extends keyof EventMap>(key: K, fn: Handler<K>): () => void {
    const set = this.handlers.get(key) ?? new Set<(payload: never) => void>()
    this.handlers.set(key, set)
    set.add(fn as unknown as (payload: never) => void)
    return () => {
      set.delete(fn as unknown as (payload: never) => void)
    }
  }

  emit<K extends keyof EventMap>(key: K, payload: EventMap[K]): void {
    const set = this.handlers.get(key) as unknown as Set<Handler<K>> | undefined
    set?.forEach(fn => fn(payload))
  }
}

export const bus = new EventBus()
