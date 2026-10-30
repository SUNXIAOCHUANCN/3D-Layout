/**
 * 共享写门面 —— EditorWritePort 的通用实现核（W03）。
 *
 * 真实 editorAdapter（包 core edit）与 tests/fakes/FakeEditor（内存文档）都构建在
 * 这一份逻辑之上：令牌武装、惰性事务（首次写入才 begin，§5.3）、幂等键
 * （runId+taskId+toolCallId，§6.4）、写作用域、指纹校验、core boolean 失败映射。
 * 两边只注入不同的底层原子操作（WriteTargetPrimitives），保证 contract test
 * 等价——fake 不会比真实 core 更宽松（SPEC §5.2）。
 *
 * 本文件不导入任何宿主运行时（core/react/three）。
 */

import type {
  AuthorizedCallContext,
  EditReceipt,
  EditorCommand,
  EditorWritePort,
  ObjectId,
  RunCommitReceipt,
  ToolError,
  ToolResult,
  TransformDTO,
  WriteToken,
} from '../contracts'
import { CoAgentError } from '../contracts'
import { computeAssetFingerprint } from '../schemas'

/** 门面看到的对象视图（真实=frozen 的 core 资产换算；fake=内存记录） */
export interface WriteTargetObject {
  id: ObjectId
  ref: string
  name: string | null
  transform: TransformDTO
  visible: boolean
  fingerprint: string
}

/** 已解析的底层写命令（add 已铸造 id） */
export type PreparedWrite =
  | { kind: 'add'; objectId: ObjectId; ref: string; name: string | null; transform: TransformDTO }
  | { kind: 'transform'; objectId: ObjectId; transform: TransformDTO }
  | { kind: 'remove'; objectId: ObjectId }

export interface WriteTargetPrimitives {
  getObject(objectId: ObjectId): WriteTargetObject | undefined
  refExists(ref: string): boolean
  /** 为新资产铸造场景内唯一 id（幂等于当前文档内容） */
  mintId(ref: string): ObjectId
  /** 打开底层事务（惰性：首次写入时由门面调用） */
  beginTargetTx(label: string): unknown
  /** 在打开的事务内执行已解析命令；失败返回 ToolError（不抛） */
  executeWrite(
    tx: unknown,
    prepared: PreparedWrite,
  ): { objectId: ObjectId; fingerprintAfter: string } | { error: ToolError }
  commitTargetTx(tx: unknown): boolean
  rollbackTargetTx(tx: unknown): boolean
  /**
   * P3：取底层事务 id（core 的 `TxHandle.id`）。
   * 可选——不支持历史记录的实现可以不给，此时提交回执里的 transactionId 为 null，
   * 上层据此**不生成**撤销入口（而不是给一个点不动的按钮）。
   */
  transactionIdOf?(tx: unknown): number | null
}

export interface WriteFacadeState {
  armedLabel: string | null
  /** 已物化（发生过写入）的事务是否仍打开 */
  materializedOpen: boolean
  committedRuns: number
  rolledBackRuns: number
  orphanedTxLabels: string[]
  invalidatedReasons: string[]
}

/** 门面覆盖 EditorWritePort 除 save 外的全部能力（save 是各适配层的 IO，不入共享门面） */
/** 撤销三件套属于宿主历史，也不进共享门面（fake 与真实 core 语义不同） */
export type EditorWriteFacade = Omit<EditorWritePort, 'save' | 'queryUndo' | 'undoRun' | 'sceneSessionId'> & {
  /** 诊断：武装/提交/回滚计数 */
  state(): WriteFacadeState
  /** 场景切换等外部原因作废当前武装事务 */
  invalidateAll(reason: string): void
}

function mintToken(): WriteToken {
  return { __coagentWriteToken: true } as const
}

export function createEditorWriteFacade(primitives: WriteTargetPrimitives): EditorWriteFacade {
  interface Armed {
    label: string
    token: WriteToken
    tx: unknown | null
  }
  let armed: Armed | null = null
  const idempotency = new Map<string, { commandKey: string; receipt: EditReceipt }>()
  /** P3：本次提交包含多少次真实写入（0 表示没有可撤销的修改） */
  let writesInRun = 0
  const state: WriteFacadeState = {
    armedLabel: null,
    materializedOpen: false,
    committedRuns: 0,
    rolledBackRuns: 0,
    orphanedTxLabels: [],
    invalidatedReasons: [],
  }

  const err = (e: CoAgentError): ToolResult<EditReceipt> => ({ ok: false, error: e.toToolError() })

  return {
    beginRun(label: string): WriteToken {
      if (armed) {
        // 真实 core 语义：begin 顶掉未关闭事务——已物化的修改保留但不可再回滚（W00 §1.2）
        state.orphanedTxLabels.push(armed.label)
      }
      armed = { label, token: mintToken(), tx: null }
      state.armedLabel = label
      state.materializedOpen = false
      writesInRun = 0
      return armed.token
    },

    commitRun(token: WriteToken): RunCommitReceipt {
      // 与 core 一致：令牌不匹配静默 no-op——但回执必须说清楚"没提交"
      if (armed?.token !== token) return { committed: false, historyTransactionId: null, writes: 0 }
      const tx = armed.tx
      let committed = false
      let historyTransactionId: number | null = null
      if (tx !== null) {
        committed = primitives.commitTargetTx(tx)
        // 只有真的提交了才给可撤销引用
        historyTransactionId = committed ? (primitives.transactionIdOf?.(tx) ?? null) : null
      }
      const writes = writesInRun
      state.committedRuns++
      armed = null
      state.armedLabel = null
      state.materializedOpen = false
      writesInRun = 0
      return { committed, historyTransactionId, writes }
    },

    rollbackRun(token: WriteToken): boolean {
      if (armed?.token !== token) return false
      if (armed.tx !== null) {
        if (!primitives.rollbackTargetTx(armed.tx)) {
          // 底层回滚失败：保持记录，controller 应转 error_locked
          state.rolledBackRuns++
          armed = null
          state.armedLabel = null
          state.materializedOpen = false
          return false
        }
      }
      state.rolledBackRuns++
      armed = null
      state.armedLabel = null
      state.materializedOpen = false
      return true
    },

    endRun(token: WriteToken): void {
      if (armed?.token === token) {
        armed = null
        state.armedLabel = null
        state.materializedOpen = false
      }
      idempotency.clear()
    },

    applyAuthorized(command: EditorCommand, ctx: AuthorizedCallContext): ToolResult<EditReceipt> {
      // 授权检查与执行在同一同步临界区（§6.4：中间不得 await）
      if (!armed || armed.token !== ctx.token) {
        return err(new CoAgentError('write_failed', '无活跃授权事务（run 未 begin、已结束或已被顶替）'))
      }
      const key = `${ctx.runId}|${ctx.taskId ?? '-'}|${ctx.toolCallId}`
      const commandKey = JSON.stringify(command)
      const hit = idempotency.get(key)
      if (hit) {
        if (hit.commandKey === commandKey) return { ok: true, data: { ...hit.receipt, idempotentHit: true } }
        return err(new CoAgentError('invalid_arguments', '相同幂等键（run+task+toolCall）携带了不同参数'))
      }

      let prepared: PreparedWrite
      if (command.kind === 'add') {
        if (!primitives.refExists(command.ref)) {
          return err(new CoAgentError('asset_not_found', `模型库中不存在 ${command.ref}`))
        }
        prepared = {
          kind: 'add',
          objectId: primitives.mintId(command.ref),
          ref: command.ref,
          name: command.name ?? null,
          transform: command.transform,
        }
      } else {
        if (!ctx.writableObjectIds.has(command.objectId)) {
          return err(new CoAgentError('out_of_scope', `对象 ${command.objectId} 不在本 run 的写权限集合内`))
        }
        const cur = primitives.getObject(command.objectId)
        if (!cur) return err(new CoAgentError('asset_not_found', `对象 ${command.objectId} 不存在`))
        if (cur.fingerprint !== command.expectedFingerprint) {
          // 目标 transform 与当前状态**已经一致** → 视为"已达成"，返回成功。
          // 为什么必须有这条：真实模型会重发同一条命令（幂等键含 toolCallId，
          // 每次调用 id 不同 → 幂等缓存命不中），而第一次写入已把指纹改掉，
          // 于是重发会被判 stale_object → 模型看到失败就再发 → 死循环直到超预算
          // （2026-10-22 T14 实测：模型已写完 4 个对象、几何 clear、也拍完 after 图，
          //  却因为重发被拒而耗尽 6 轮预算）。
          if (command.kind === 'transform' && sameTransform(cur.transform, command.transform)) {
            return {
              ok: true,
              data: {
                command,
                objectId: command.objectId,
                fingerprintAfter: cur.fingerprint,
                alreadySatisfied: true,
              } as EditReceipt,
            }
          }
          return err(new CoAgentError('stale_object', `对象 ${command.objectId} 指纹过期，需重新观察`))
        }
        prepared =
          command.kind === 'transform'
            ? { kind: 'transform', objectId: command.objectId, transform: command.transform }
            : { kind: 'remove', objectId: command.objectId }
      }

      // 惰性事务：首轮 baseline 之后的第一次写入才真正 begin（§5.3）
      if (armed.tx === null) armed.tx = primitives.beginTargetTx(armed.label)
      state.materializedOpen = true

      const done = primitives.executeWrite(armed.tx, prepared)
      if ('error' in done) return { ok: false, error: done.error }

      const receipt: EditReceipt = {
        command,
        objectId: done.objectId,
        fingerprintAfter: done.fingerprintAfter,
      }
      idempotency.set(key, { commandKey, receipt })
      writesInRun++
      return { ok: true, data: receipt }
    },

    invalidateAll(reason: string): void {
      if (armed) {
        state.invalidatedReasons.push(`${armed.label}：${reason}`)
        if (armed.tx !== null) state.orphanedTxLabels.push(armed.label)
        armed = null
        state.armedLabel = null
        state.materializedOpen = false
      }
      idempotency.clear()
    },

    state(): WriteFacadeState {
      return { ...state, orphanedTxLabels: [...state.orphanedTxLabels], invalidatedReasons: [...state.invalidatedReasons] }
    },
  }
}

/** 便捷：指纹计算入口共享（与 schemas 的规范化口径一致） */
export function fingerprintOf(o: WriteTargetObject): string {
  return computeAssetFingerprint({ ref: o.ref, transform: o.transform, visible: o.visible })
}

/**
 * 两个 transform 是否"落在同一处"（容差口径与渲染层矩阵比对一致：1e-3）。
 * 用于识别"模型重发同一条命令、目标其实已经达成"的情况。
 */
export function sameTransform(a: TransformDTO, b: TransformDTO): boolean {
  const EPS = 1e-3
  const near = (x: number, y: number): boolean => Math.abs(x - y) <= EPS
  if (!a.position.every((v, i) => near(v, b.position[i]))) return false
  if (!a.rotationDeg.every((v, i) => near(v, b.rotationDeg[i]))) return false
  if (!a.scale.every((v, i) => near(v, b.scale[i]))) return false
  return true
}
