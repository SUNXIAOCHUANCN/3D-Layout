/**
 * runState（P1）——一轮运行内的对象归属与任务台账，**唯一权威**。
 *
 * 为什么需要它：修订前的"本轮新增对象"散在 4 处（RegionState.writes、
 * TaskResult.createdObjectIds、registry.createdByRegion、runController.writable），
 * 各自更新、口径不同，于是出现"修复轮不知道已经加过两栋，又加两栋"。
 *
 * 本服务只做三件事：
 *   1. 记录每个任务创建/修改/删除了什么（对象级、幂等登记）；
 *   2. 在写入前用**存活新增数**做名额检查（不是调用次数、不是区域总量）；
 *   3. 用同一份成员口径回答"这个区域现在有哪些对象、哪些可写"。
 *
 * 全部方法是同步的：必须在场景队列内一次完成"检查 → 写入 → 登记"，
 * 中间不能 await，否则排队期间状态会变。
 */

import type {
  EditorCommand,
  ObjectId,
  Region,
  RegionView,
  RunStatePort,
  TaskId,
  TaskLedgerView,
  ToolCallId,
  ToolError,
  UnitTask,
} from '../contracts'
import { CoAgentError } from '../contracts'

type Ledger = {
  taskId: TaskId
  regionId: string
  phase: 'initial' | 'repair'
  attempt: number
  /** 累计创建（顺序即创建顺序，保留审计语义） */
  created: ObjectId[]
  /** 创建后被删除的 */
  removed: Set<ObjectId>
  modified: Set<ObjectId>
  /** 已成功写入的幂等键：命中说明是重放，不再消耗名额 */
  appliedKeys: Set<string>
  creationTarget: { minCount: number; maxCount: number } | null
  allowedOperations: readonly string[]
}

export interface RunStateOptions {
  runId: string
  /** 冻结分区里的全局只读对象：它们可见但永不可写 */
  readonlyObjectIds?: readonly ObjectId[]
}

function receiptKey(taskId: TaskId | null, toolCallId: ToolCallId, command: EditorCommand): string {
  return `${taskId ?? '-'}|${toolCallId}|${JSON.stringify(command)}`
}

export function createRunState(opts: RunStateOptions): RunStatePort {
  const readonlyAll = new Set<ObjectId>(opts.readonlyObjectIds ?? [])
  const ledgers = new Map<TaskId, Ledger>()
  let finished = false

  const ledgerOf = (taskId: TaskId | null): Ledger | null => (taskId ? ledgers.get(taskId) ?? null : null)

  /** 存活新增：创建过且没被删（live 给出时再按当前场景过滤） */
  const liveCreated = (l: Ledger, live?: ReadonlySet<ObjectId>): ObjectId[] =>
    l.created.filter(id => !l.removed.has(id) && (live === undefined || live.has(id)))

  const fail = (message: string, details?: Record<string, unknown>): ToolError =>
    new CoAgentError('task_creation_limit', message, { details: details ?? {} }).toToolError()

  return {
    registerTasks(tasks: UnitTask[]): void {
      if (finished) return
      for (const t of tasks) {
        const existing = ledgers.get(t.id)
        if (existing) {
          // 重复注册不重置台账（同一任务可能在修复轮再次登记）
          existing.creationTarget = t.creationTarget ?? null
          existing.allowedOperations = t.allowedOperations
          continue
        }
        ledgers.set(t.id, {
          taskId: t.id,
          regionId: t.regionId,
          phase: 'initial',
          attempt: 0,
          created: [],
          removed: new Set(),
          modified: new Set(),
          appliedKeys: new Set(),
          creationTarget: t.creationTarget ?? null,
          allowedOperations: t.allowedOperations,
        })
      }
    },

    setPhase(taskId: TaskId, phase: 'initial' | 'repair', attempt: number): void {
      const l = ledgers.get(taskId)
      if (!l) return
      l.phase = phase
      l.attempt = attempt
    },

    checkWrite(taskId: TaskId | null, command: EditorCommand, toolCallId: ToolCallId): ToolError | null {
      // 注意：这里**不**拦"本轮已结束"。终态拒绝迟到写入由写门面的 token 校验负责，
      // 它返回的 write_failed 才是既有语义；在这里另造一个 cancelled 会覆盖掉更准确的原因。
      const l = ledgerOf(taskId)
      // 未登记任务（主干/判定期/测试直连工具）不施加任务级规则；run token 与指纹仍在
      if (!l) return null

      // 1. 幂等重放必须在名额检查之前放行，否则"新增成功但响应丢失"的重试会被判超额
      if (l.appliedKeys.has(receiptKey(taskId, toolCallId, command))) return null

      if (command.kind !== 'add') return null

      // 2. 任务必须显式声明 add
      if (!l.allowedOperations.includes('add')) {
        return new CoAgentError('out_of_scope', `任务 ${l.taskId} 未声明 add 操作，不能新增对象`, {
          details: { taskId: l.taskId, allowedOperations: [...l.allowedOperations] },
        }).toToolError()
      }

      // 3. 存活新增数不得超过上限
      const cap = l.creationTarget?.maxCount
      if (cap !== undefined) {
        const live = liveCreated(l)
        if (live.length >= cap) {
          return fail(
            `任务 ${l.taskId} 的新增名额已用尽（${live.length}/${cap}）。请调整已有对象（${live.join(', ') || '无'}），或先删除一个再新增。`,
            {
              taskId: l.taskId,
              current: live.length,
              max: cap,
              liveCreatedObjectIds: live,
              suggestion: 'edit.transform 调整现有对象，或 edit.remove 删除后重新 edit.add',
            },
          )
        }
      }
      return null
    },

    recordWrite(taskId: TaskId | null, command: EditorCommand, objectId: ObjectId, toolCallId: ToolCallId): void {
      const l = ledgerOf(taskId)
      if (!l) return
      l.appliedKeys.add(receiptKey(taskId, toolCallId, command))
      if (command.kind === 'add') {
        if (!l.created.includes(objectId)) l.created.push(objectId)
        l.removed.delete(objectId)
        return
      }
      if (command.kind === 'remove') {
        l.removed.add(objectId)
        l.modified.add(objectId)
        return
      }
      l.modified.add(objectId)
    },

    getTaskLedger(taskId: TaskId, live: ReadonlySet<ObjectId>): TaskLedgerView | null {
      const l = ledgers.get(taskId)
      if (!l) return null
      const liveCreatedIds = liveCreated(l, live)
      const cap = l.creationTarget?.maxCount
      return {
        taskId: l.taskId,
        regionId: l.regionId,
        phase: l.phase,
        attempt: l.attempt,
        liveCreatedObjectIds: liveCreatedIds,
        removedObjectIds: [...l.removed].filter(id => !live.has(id)),
        modifiedObjectIds: [...l.modified].filter(id => live.has(id)),
        remainingAddCapacity: cap === undefined ? null : Math.max(0, cap - liveCreatedIds.length),
      }
    },

    resolveRegion(region: Region, live: ReadonlySet<ObjectId>, sceneRevision: number): RegionView {
      // 成员 = (初始归属 ∪ 本轮在该区创建) ∩ 当前存在
      const createdHere: ObjectId[] = []
      for (const l of ledgers.values()) {
        if (l.regionId !== region.id) continue
        for (const id of liveCreated(l)) createdHere.push(id)
      }
      const members = [...new Set([...region.objectIds, ...createdHere])].filter(id => live.has(id))
      const readonlyIds = members.filter(id => readonlyAll.has(id))
      const readonlySet = new Set(readonlyIds)
      return {
        regionId: region.id,
        memberIds: members,
        writableIds: members.filter(id => !readonlySet.has(id)),
        readonlyIds,
        // 快照不带"归属歧义"信息；歧义对象在预处理报告里，运行时按不可写处理（P4 会补 unresolved）
        unresolvedIds: [],
        sceneRevision,
      }
    },

    liveCreatedObjectIds(live: ReadonlySet<ObjectId>): ObjectId[] {
      const out: ObjectId[] = []
      for (const l of ledgers.values()) out.push(...liveCreated(l, live))
      return [...new Set(out)]
    },

    summary(live: ReadonlySet<ObjectId>): Array<{ taskId: TaskId; liveCreated: number; remaining: number | null }> {
      return [...ledgers.values()].map(l => {
        const n = liveCreated(l, live).length
        const cap = l.creationTarget?.maxCount
        return { taskId: l.taskId, liveCreated: n, remaining: cap === undefined ? null : Math.max(0, cap - n) }
      })
    },

    finish(): void {
      finished = true
      ledgers.clear()
    },
  }
}

/** 诊断用：台账的 runId（日志里对账） */
export function runStateLabel(runId: string): string {
  return `runState:${runId}`
}
