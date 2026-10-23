/**
 * 几何工具（W05）——把 `context.render.geometry` 包成模型可调用的形状。
 *
 * W08.3 起渲染端口返回真实 AABB/三角形/包含/接触结果；本工具只负责"把请求/
 * 结果规规矩矩转过去"，并校验对象对与容差，避免模型传垃圾参数。unknown 仍然
 * 必须当"证据不足"，不能当 clear。
 */

import type { GeometryRequest, GeometryResult, WorkflowContext } from '../contracts'
import { CoAgentError } from '../contracts'

export async function checkGeometry(
  context: WorkflowContext,
  args: { objectIds: string[]; staticObjectIds?: string[]; contactToleranceM?: number; allowGroundContact?: boolean },
): Promise<GeometryResult> {
  const all = new Set([...args.objectIds, ...(args.staticObjectIds ?? [])])
  if (all.size < 2) throw new CoAgentError('invalid_arguments', 'geometry.check 至少需要两个不同对象')
  const tolerance = args.contactToleranceM ?? 0.02
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new CoAgentError('invalid_arguments', 'contactToleranceM 必须是非负有限数')
  const request: GeometryRequest = {
    objectIds: [...args.objectIds],
    ...(args.staticObjectIds ? { staticObjectIds: [...args.staticObjectIds] } : {}),
    contactToleranceM: tolerance,
    allowGroundContact: args.allowGroundContact ?? false,
  }
  return context.render.geometry(request, context.signal)
}
