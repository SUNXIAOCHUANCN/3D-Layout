/**
 * 工具注册表（W05，SPEC §3.6）。
 *
 * 一句话：**模型只能通过这里碰场景**，而这里对"谁能调什么、能写哪里、花多少钱"负责：
 * - 角色过滤：judge 只有只读/渲染工具，写工具对 judge 根本不存在（不是靠提示词约束）；
 * - 作用域：写操作必须落在本次调用的 region 内，且不能是 global_readonly；
 * - 基线：写操作必须带指纹或基线证据（见 editTools.resolveExpectedFingerprint）；
 * - 预算：每任务工具调用数受限（config.toolBudgetPerTask），超限 budget_exceeded；
 * - 参数：全部经 tools/args 收口，模型给的任何形状都不会直接进核心。
 *
 * 工具定义与 handler 的入参/出参都是 JSON 友好的，便于直接喂给 ModelPort.tools。
 */

import type {
  AgentRole,
  CameraSnapshot,
  EditReceipt,
  ModelToolSpec,
  Observation,
  ObservationPhase,
  Region,
  ToolDef,
  ToolName,
  ToolResult,
  WorkflowContext,
} from '../contracts'
import { CoAgentError, TOOL_NAMES } from '../contracts'
import { optBool, optNumber, optString, optStringArray, reqRecord, reqString, reqStringArray, fail } from './args'
import { captureWith, focusCamera, regionCamera } from './cameraTools'
import { applyCommand, parseTransform, resolveExpectedFingerprint } from './editTools'
import { checkGeometry } from './geometryTools'
import { getObjects, listRegion, searchLibrary } from './sceneTools'
import { validateCameraSnapshot } from '../schemas'

export interface ToolCallSite {
  runId: string
  taskId: string | null
  regionId: string | null
  role: AgentRole
  toolCallId: string
}

export interface ToolRegistry {
  /** 给模型看的工具清单（已按角色过滤） */
  specs(role: AgentRole): ModelToolSpec[]
  call(name: string, args: Record<string, unknown>, site: ToolCallSite): Promise<ToolResult<unknown>>
  /** 某任务已用掉多少工具调用（预算断言用） */
  toolCalls(taskId: string | null): number
}

export interface ToolRegistryOptions {
  maxCallsPerTask: number
}

const READ_ROLES: AgentRole[] = ['main', 'executor', 'judge']
const EXEC_ROLES: AgentRole[] = ['executor']

const SCHEMAS: Record<ToolName, Record<string, unknown>> = {
  'scene.list_region': { type: 'object', properties: { regionId: { type: 'string' } }, additionalProperties: false },
  'scene.get_objects': { type: 'object', properties: { objectIds: { type: 'array', items: { type: 'string' }, minItems: 1 } }, required: ['objectIds'] },
  'library.search': { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } } },
  'camera.capture': {
    type: 'object',
    properties: {
      phase: { type: 'string', enum: ['baseline', 'task_before', 'after', 'supplement'] },
      camera: { type: 'object' },
      objectIds: { type: 'array', items: { type: 'string' } },
      marked: { type: 'boolean' },
    },
  },
  'camera.focus': { type: 'object', properties: { objectIds: { type: 'array', items: { type: 'string' }, minItems: 1 }, distanceMul: { type: 'number' } }, required: ['objectIds'] },
  'camera.set': { type: 'object', properties: { camera: { type: 'object' } }, required: ['camera'] },
  'edit.add': { type: 'object', properties: { ref: { type: 'string' }, name: { type: 'string' }, transform: { type: 'object' } }, required: ['ref', 'transform'] },
  'edit.transform': {
    type: 'object',
    properties: { objectId: { type: 'string' }, transform: { type: 'object' }, expectedFingerprint: { type: 'string' }, basisObservationId: { type: 'string' } },
    required: ['objectId', 'transform'],
  },
  'edit.remove': {
    type: 'object',
    properties: { objectId: { type: 'string' }, expectedFingerprint: { type: 'string' }, basisObservationId: { type: 'string' } },
    required: ['objectId'],
  },
  'geometry.check': {
    type: 'object',
    properties: {
      objectIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
      staticObjectIds: { type: 'array', items: { type: 'string' } },
      contactToleranceM: { type: 'number' },
      allowGroundContact: { type: 'boolean' },
    },
    required: ['objectIds'],
  },
}

export function createToolRegistry(context: WorkflowContext, opts: ToolRegistryOptions): ToolRegistry {
  const budget = new Map<string, number>()
  const createdByRegion = new Map<string, Set<string>>()
  const readonly = new Set(context.partition.globalReadonlyObjectIds)

  const regionOf = (regionId: string | null): Region => {
    const region = regionId ? context.partition.regions.find(r => r.id === regionId) : undefined
    if (!region) throw new CoAgentError('out_of_scope', `调用缺少有效的 region 上下文（regionId=${regionId ?? 'null'}）`)
    return region
  }

  const writableIn = (regionId: string | null, objectId: string): boolean => {
    const region = regionOf(regionId)
    if (readonly.has(objectId)) return false
    if (region.objectIds.includes(objectId)) return true
    return createdByRegion.get(region.id)?.has(objectId) ?? false
  }

  const tools: Record<ToolName, ToolDef> = {
    'scene.list_region': {
      name: 'scene.list_region',
      description: '列出分区与每区的对象 id（只读）',
      inputSchema: SCHEMAS['scene.list_region'],
      allowedRoles: READ_ROLES,
      effect: 'read',
      async handler(args) {
        return { ok: true, data: { regions: listRegion(context, context.partition, optString(args, 'regionId')) } }
      },
    },

    'scene.get_objects': {
      name: 'scene.get_objects',
      description: '读取对象当前 transform/可见性/指纹（一次最多 20 个）',
      inputSchema: SCHEMAS['scene.get_objects'],
      allowedRoles: READ_ROLES,
      effect: 'read',
      async handler(args) {
        const ids = reqStringArray(args, 'objectIds', { min: 1 })
        if (ids.length > 20) fail('objectIds', '一次最多 20 个')
        return { ok: true, data: getObjects(context, ids) }
      },
    },

    'library.search': {
      name: 'library.search',
      description: '在模型库里按名字/ref 搜索可新增的资产（只读）',
      inputSchema: SCHEMAS['library.search'],
      allowedRoles: READ_ROLES,
      effect: 'read',
      async handler(args) {
        const query = optString(args, 'query') ?? ''
        // limit 越界**不报错**，直接夹到 [1,10]：模型偶尔会要 12，
        // 报错只会白白多花一轮（真机实测 2026-10-22）。这里不传 max 给 optNumber，
        // 否则会先抛错、根本走不到夹取。
        const raw = optNumber(args, 'limit', { integer: true }) ?? 5
        const limit = Math.max(1, Math.min(10, Math.trunc(raw)))
        return { ok: true, data: searchLibrary(context, query, limit) }
      },
    },

    'camera.capture': {
      name: 'camera.capture',
      description: '拍一张证据图：默认拍本区俯视图；没有 region 上下文时必须自带 camera 快照',
      inputSchema: SCHEMAS['camera.capture'],
      allowedRoles: READ_ROLES,
      effect: 'render',
      async handler(args, ctx) {
        const phaseRaw = optString(args, 'phase') ?? 'supplement'
        const phases: ObservationPhase[] = ['preprocess', 'baseline', 'task_before', 'after', 'supplement']
        if (!phases.includes(phaseRaw as ObservationPhase)) fail('phase', `必须是 ${phases.join('/')}`)
        const cameraArg = args.camera
        // region 上下文是**可选**的：planner（main 角色）没有 regionId，
        // 但它仍然可以拍图核对事实——此时必须自带 camera 快照。
        // （旧实现无条件 regionOf()，planner 一调 camera.capture 就必然 out_of_scope。）
        const region = ctx.regionId ? context.partition.regions.find(r => r.id === ctx.regionId) : undefined
        if (!region && cameraArg === undefined) {
          throw new CoAgentError(
            'out_of_scope',
            `当前没有 region 上下文（regionId=${ctx.regionId ?? 'null'}）：请在 camera 参数里给出相机快照`,
          )
        }
        let camera: CameraSnapshot
        if (cameraArg === undefined) {
          camera = regionCamera(region as Region)
        } else {
          const check = validateCameraSnapshot(cameraArg)
          if (!check.ok) {
            throw new CoAgentError('invalid_arguments', `camera 非法：${check.issues.map(i => `${i.path} ${i.message}`).join('; ')}`)
          }
          camera = cameraArg as CameraSnapshot
        }
        const requested = optStringArray(args, 'objectIds') ?? region?.objectIds ?? []
        const observation: Observation = await captureWith(context, {
          runId: ctx.runId,
          camera,
          phase: phaseRaw as ObservationPhase,
          objectIds: requested,
          marked: optBool(args, 'marked') ?? true,
          taskId: ctx.taskId,
          regionId: region ? region.id : null,
        })
        return { ok: true, data: observation, evidenceIds: [observation.id] }
      },
    },

    'camera.focus': {
      name: 'camera.focus',
      description: '为若干对象生成一台聚焦透视相机快照（只产出快照，不拍摄）',
      inputSchema: SCHEMAS['camera.focus'],
      allowedRoles: READ_ROLES,
      effect: 'read',
      async handler(args) {
        const ids = reqStringArray(args, 'objectIds', { min: 1 })
        const mul = optNumber(args, 'distanceMul', { min: 1, max: 8 }) ?? 2.4
        return { ok: true, data: { camera: focusCamera(context, ids, mul) } }
      },
    },

    'camera.set': {
      name: 'camera.set',
      description: '校验并回显一台相机快照（供后续 camera.capture 复用，保证同视角）',
      inputSchema: SCHEMAS['camera.set'],
      allowedRoles: READ_ROLES,
      effect: 'read',
      async handler(args) {
        const raw = reqRecord(args, 'camera')
        const check = validateCameraSnapshot(raw)
        if (!check.ok) throw new CoAgentError('invalid_arguments', `camera 非法：${check.issues.map(i => `${i.path} ${i.message}`).join('; ')}`)
        return { ok: true, data: { camera: raw as CameraSnapshot } }
      },
    },

    'edit.add': {
      name: 'edit.add',
      description: '在本区新增一个模型库资产（返回新对象 id 与回执）',
      inputSchema: SCHEMAS['edit.add'],
      allowedRoles: EXEC_ROLES,
      effect: 'write',
      async handler(args, ctx) {
        const region = regionOf(ctx.regionId)
        const ref = reqString(args, 'ref')
        const transform = parseTransform(args.transform, 'transform')
        const result = await applyCommand(
          context,
          {
            kind: 'add',
            ref,
            ...(optString(args, 'name') !== undefined ? { name: optString(args, 'name') } : {}),
            transform,
          },
          { taskId: ctx.taskId, toolCallId: ctx.toolCallId, regionId: region.id },
        )
        if (result.ok) {
          const set = createdByRegion.get(region.id) ?? new Set<string>()
          set.add(result.data.objectId)
          createdByRegion.set(region.id, set)
        }
        return result
      },
    },

    'edit.transform': {
      name: 'edit.transform',
      description: '改本区对象的 transform（必须带基线指纹或 basisObservationId）',
      inputSchema: SCHEMAS['edit.transform'],
      allowedRoles: EXEC_ROLES,
      effect: 'write',
      async handler(args, ctx) {
        const region = regionOf(ctx.regionId)
        const objectId = reqString(args, 'objectId')
        if (!writableIn(region.id, objectId)) {
          throw new CoAgentError('out_of_scope', `对象 ${objectId} 不在本区（${region.id}）可写集合内`)
        }
        const transform = parseTransform(args.transform, 'transform')
        const expectedFingerprint = resolveExpectedFingerprint(context, {
          objectId,
          ...(optString(args, 'expectedFingerprint') !== undefined ? { expectedFingerprint: optString(args, 'expectedFingerprint') } : {}),
          ...(optString(args, 'basisObservationId') !== undefined ? { basisObservationId: optString(args, 'basisObservationId') } : {}),
        })
        const result = await applyCommand(
          context,
          { kind: 'transform', objectId, transform, expectedFingerprint },
          { taskId: ctx.taskId, toolCallId: ctx.toolCallId, regionId: region.id },
        )
        // 已达成时明确告诉模型"不用再改"：否则模型会把这当成待办而反复重发，
        // 耗尽工具轮次预算（2026-10-22 T14 实测）。
        if (result.ok) {
          const receipt = result.data as EditReceipt
          if (receipt.alreadySatisfied) {
            return {
              ok: true,
              data: {
                ...receipt,
                message: `对象 ${objectId} 已经处于目标 transform，无需再次修改；请勿重复调用本工具。`,
              },
            }
          }
        }
        return result
      },
    },

    'edit.remove': {
      name: 'edit.remove',
      description: '删除本区对象（必须带基线指纹或 basisObservationId）',
      inputSchema: SCHEMAS['edit.remove'],
      allowedRoles: EXEC_ROLES,
      effect: 'write',
      async handler(args, ctx) {
        const region = regionOf(ctx.regionId)
        const objectId = reqString(args, 'objectId')
        if (!writableIn(region.id, objectId)) {
          throw new CoAgentError('out_of_scope', `对象 ${objectId} 不在本区（${region.id}）可写集合内`)
        }
        const expectedFingerprint = resolveExpectedFingerprint(context, {
          objectId,
          ...(optString(args, 'expectedFingerprint') !== undefined ? { expectedFingerprint: optString(args, 'expectedFingerprint') } : {}),
          ...(optString(args, 'basisObservationId') !== undefined ? { basisObservationId: optString(args, 'basisObservationId') } : {}),
        })
        return applyCommand(
          context,
          { kind: 'remove', objectId, expectedFingerprint },
          { taskId: ctx.taskId, toolCallId: ctx.toolCallId, regionId: region.id },
        )
      },
    },

    'geometry.check': {
      name: 'geometry.check',
      description: '检查对象间的接触/包含关系（W08.3：AABB/三角形/包含；unknown 表示证据不足）',
      inputSchema: SCHEMAS['geometry.check'],
      allowedRoles: READ_ROLES,
      effect: 'read',
      async handler(args) {
        const ids = reqStringArray(args, 'objectIds', { min: 1 })
        const statics = optStringArray(args, 'staticObjectIds')
        const tolerance = optNumber(args, 'contactToleranceM', { min: 0, max: 10 })
        const allowGround = optBool(args, 'allowGroundContact')
        const data = await checkGeometry(context, {
          objectIds: ids,
          ...(statics !== undefined ? { staticObjectIds: statics } : {}),
          ...(tolerance !== undefined ? { contactToleranceM: tolerance } : {}),
          ...(allowGround !== undefined ? { allowGroundContact: allowGround } : {}),
        })
        return { ok: true, data }
      },
    },
  }

  // 可选：schema 与契约里的工具名集合必须一致（少一个/多一个都是接线错误）
  const missing = TOOL_NAMES.filter(n => !(n in tools))
  if (missing.length > 0) throw new Error(`工具注册表缺少实现：${missing.join(', ')}`)

  return {
    specs(role) {
      return TOOL_NAMES.filter(name => tools[name].allowedRoles.includes(role)).map(name => ({
        name,
        description: tools[name].description,
        schema: tools[name].inputSchema,
      }))
    },

    async call(name, args, site) {
      const def = tools[name as ToolName]
      if (!def) {
        return { ok: false, error: new CoAgentError('invalid_arguments', `未知工具：${name}`).toToolError() }
      }
      if (!def.allowedRoles.includes(site.role)) {
        return {
          ok: false,
          error: new CoAgentError('out_of_scope', `角色 ${site.role} 不允许调用 ${name}（只读/写入权限按角色固定）`).toToolError(),
        }
      }
      const key = site.taskId ?? '__main__'
      const used = budget.get(key) ?? 0
      if (used >= opts.maxCallsPerTask) {
        return {
          ok: false,
          error: new CoAgentError('budget_exceeded', `任务 ${key} 工具调用已达上限 ${opts.maxCallsPerTask}`, {
            details: { used },
          }).toToolError(),
        }
      }
      budget.set(key, used + 1)

      try {
        const ctx = {
          runId: site.runId,
          taskId: site.taskId,
          regionId: site.regionId,
          role: site.role,
          signal: context.signal,
          token: null,
          toolCallId: site.toolCallId,
        }
        return await def.handler(args, ctx)
      } catch (e) {
        return { ok: false, error: CoAgentError.from(e).toToolError() }
      }
    },

    toolCalls: taskId => budget.get(taskId ?? '__main__') ?? 0,
  }
}
