/**
 * 编辑工具（W05）——模型的唯一写路径。
 *
 * 红线（§5.2/§6.4）：
 * - 只允许 executor 调用（registry 里按角色过滤）；
 * - 只能写本区对象（registry 校验作用域，越界直接 out_of_scope）；
 * - 必须带"基线指纹"（显式 expectedFingerprint 或 basisObservationId 里的指纹），
 *   否则拒绝——没有基线的写入无法判断是不是基于旧画面做的决定；
 * - 真正执行走 `context.applyWrite`（事务/幂等/作用域/指纹都在门面内），工具不碰 core。
 */

import type { AssetDTO, EditorCommand, EditReceipt, ModelCatalogEntry, Observation, ToolResult, TransformDTO, WorkflowContext } from '../contracts'
import { CoAgentError } from '../contracts'
import { checkRegionContainment } from '../services/validation'
import { validateTransformDTO } from '../schemas'

/**
 * W08.1（SPEC §6.2）：写入前检查目标落点是否在本区。
 * 有模型尺寸时用保守的世界 AABB 地面投影；没有尺寸只判中心点（unknown 不拦写入，
 * 但终检不会把 unknown 当硬约束通过）。
 */
function assertInsideRegion(
  context: WorkflowContext,
  regionId: string | null,
  transform: TransformDTO,
  catalog: ModelCatalogEntry | null,
  label: string,
): void {
  const region = regionId ? context.partition.regions.find(r => r.id === regionId) : undefined
  if (!region) {
    throw new CoAgentError('out_of_scope', `${label} 缺少有效区域上下文（regionId=${regionId ?? 'null'}）`)
  }
  const check = checkRegionContainment({ region, transform, catalog })
  if (check.status === 'outside') {
    throw new CoAgentError('out_of_scope', `${label} 的目标位置超出区域 ${region.id}：${check.reason}；请把落点移回区内`)
  }
}

export function resolveExpectedFingerprint(
  context: WorkflowContext,
  input: { objectId: string; expectedFingerprint?: string; basisObservationId?: string },
): string {
  if (typeof input.expectedFingerprint === 'string' && input.expectedFingerprint.length > 0) return input.expectedFingerprint
  if (typeof input.basisObservationId === 'string' && input.basisObservationId.length > 0) {
    const obs: Observation | undefined = context.getObservation(input.basisObservationId)
    if (!obs) throw new CoAgentError('invalid_arguments', `基线证据 ${input.basisObservationId} 不存在（错误证据 ID）`)
    const fp = obs.observedObjectFingerprints[input.objectId]
    if (!fp) {
      throw new CoAgentError('invalid_arguments', `基线证据 ${input.basisObservationId} 里没有对象 ${input.objectId} 的指纹`)
    }
    return fp
  }
  throw new CoAgentError('invalid_arguments', '缺少 expectedFingerprint 或 basisObservationId：写入必须基于一次观察')
}

export function parseTransform(value: unknown, path: string): TransformDTO {
  const check = validateTransformDTO(value, path)
  if (!check.ok) {
    throw new CoAgentError('invalid_arguments', `${path} 非法：${check.issues.map(i => `${i.path} ${i.message}`).join('; ')}`)
  }
  const t = value as TransformDTO
  return {
    position: [t.position[0], t.position[1], t.position[2]],
    rotationDeg: [t.rotationDeg[0], t.rotationDeg[1], t.rotationDeg[2]],
    scale: [t.scale[0], t.scale[1], t.scale[2]],
  }
}

export async function applyCommand(
  context: WorkflowContext,
  command: EditorCommand,
  call: { taskId: string | null; toolCallId: string; regionId: string | null },
): Promise<ToolResult<EditReceipt>> {
  // W08.1：写前区域检查与 core 写入在同一个工具调用内完成；越界直接 out_of_scope。
  if (command.kind === 'add') {
    const catalog = context.editorRead.snapshot({ includeCatalog: true }).catalog?.find(c => c.ref === command.ref) ?? null
    // ref 不在库里时由 writeFacade 返回 asset_not_found，这里不抢先报错
    if (catalog) assertInsideRegion(context, call.regionId, command.transform, catalog, `新增对象 ${command.ref}`)
  } else if (command.kind === 'transform') {
    const asset = context.editorRead.snapshot({ objectIds: [command.objectId] }).assets[0]
    // 对象不存在时由 writeFacade 返回 asset_not_found
    if (asset) assertInsideRegion(context, call.regionId, command.transform, asset.catalog, `对象 ${command.objectId}`)
  }
  return context.applyWrite(command, { taskId: call.taskId, toolCallId: call.toolCallId, regionId: call.regionId })
}

/** 写后回读：模型与判定都需要"现在的样子"，而不是它以为的样子 */
export function readAfterWrite(context: WorkflowContext, objectId: string): AssetDTO | undefined {
  return context.editorRead.snapshot({ objectIds: [objectId] }).assets[0]
}
