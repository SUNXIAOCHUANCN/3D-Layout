/**
 * regionViews（P2）——每区一台工作相机的运行时状态。
 *
 * 为什么需要：`camera.adjust` 是**相对**操作（环绕 +15°、拉近 0.8×）。
 * 如果每次都从俯视总览重新开始，"绕到侧面看看这栋房子朝向"就永远做不到——
 * 每次调用都会把视角重置回顶视。
 *
 * 边界：
 * - 只存在于本轮运行内，随 run 结束丢弃；
 * - **不写全局 selection**，不进编辑历史（用户主视口与历史都不该被 Agent 的观察污染）；
 * - 渲染仍共享同一份场景，这里只是"每区看它的那台相机"。
 */

import type {
  CameraSnapshot,
  ObjectId,
  ObservationId,
  RegionId,
  RegionViewState,
  RegionViews,
  Vec3,
} from '../contracts'

export function createRegionViews(): RegionViews {
  const states = new Map<RegionId, RegionViewState>()

  return {
    get(regionId: RegionId): RegionViewState | null {
      return states.get(regionId) ?? null
    },

    put(
      regionId: RegionId,
      next: {
        camera: CameraSnapshot
        target: Vec3
        focusedObjectIds?: ObjectId[]
        latestObservationId?: ObservationId | null
      },
    ): RegionViewState {
      const prev = states.get(regionId)
      const state: RegionViewState = {
        regionId,
        camera: next.camera,
        target: next.target,
        focusedObjectIds: next.focusedObjectIds ?? [],
        viewVersion: (prev?.viewVersion ?? 0) + 1,
        latestObservationId: next.latestObservationId ?? null,
      }
      states.set(regionId, state)
      return state
    },

    clearFocus(regionId: RegionId): void {
      const prev = states.get(regionId)
      if (!prev) return
      states.set(regionId, { ...prev, focusedObjectIds: [], viewVersion: prev.viewVersion + 1 })
    },

    all(): RegionViewState[] {
      return [...states.values()]
    },
  }
}

/** 供日志：一句话概括某区的工作视角 */
export function describeRegionView(state: RegionViewState): string {
  const focus = state.focusedObjectIds.length > 0 ? `聚焦 ${state.focusedObjectIds.slice(0, 3).join(',')}` : '无聚焦'
  return `${state.regionId}#v${state.viewVersion}：${focus}，相机 ${state.camera.projection}`
}
