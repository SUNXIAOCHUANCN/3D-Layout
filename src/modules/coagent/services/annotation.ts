/**
 * annotation（P2）——决定"取证截图里标注哪些对象、先标谁"。
 *
 * 为什么单独抽出来：旧实现是把 `目标 ∪ 本区可写 ∪ 本轮新增` 拼起来再 `.slice(0, 12)`，
 * 本轮**新增对象排在最后**——区里对象一多，新加的那两栋根本进不了标注预算，
 * 判定器自然"看不清新增房屋"。优先序必须是"本轮成果在前，环境在后"。
 */

import type { ObjectId } from '../contracts'

export type AnnotationPriorityInput = {
  /** 本轮新增（最重要：判定要确认的就是它们） */
  created?: ReadonlyArray<ObjectId>
  /** 本轮改过/删除过的 */
  modified?: ReadonlyArray<ObjectId>
  /** 任务目标对象 */
  targets?: ReadonlyArray<ObjectId>
  /** 本区其他可写对象（环境） */
  environment?: ReadonlyArray<ObjectId>
  /** 只读/邻区背景，最后补 */
  readonly?: ReadonlyArray<ObjectId>
}

/**
 * 按优先级去重并截断。
 *
 * 顺序：created → modified → targets → environment → readonly。
 * 去重时**保留首次出现的位置**，所以越靠前的类别越不会因为重复而丢失。
 */
export function prioritizeAnnotationIds(input: AnnotationPriorityInput, max = 12): ObjectId[] {
  const out: ObjectId[] = []
  const seen = new Set<ObjectId>()
  for (const list of [input.created, input.modified, input.targets, input.environment, input.readonly]) {
    for (const id of list ?? []) {
      if (seen.has(id)) continue
      seen.add(id)
      if (out.length >= max) continue
      out.push(id)
    }
  }
  return out
}
