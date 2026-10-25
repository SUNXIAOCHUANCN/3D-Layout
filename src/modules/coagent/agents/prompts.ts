/**
 * Agent 提示词（W05）——只放"角色契约 + 输出格式"，不放业务规则。
 *
 * 规则必须落在代码里（registry/validation/finalCheck），提示词只是让模型少犯错：
 * 写权限、作用域、证据 ID 合法性都不依赖模型自觉（§3.6）。
 */

import type { GeometryResult, UnitTask, ModelCatalogEntry } from '../contracts'

export const SYSTEM_PLANNER = `你是三维场景布局规划器。你只能输出一个 JSON 对象，不能输出解释文字。
你可以先调用只读工具（scene.list_region / scene.get_objects / library.search / camera.focus / camera.capture）核对事实，但你没有写权限。
要求：
- 只做任务拆分，不改场景；
- 对象 id 只能来自上下文里给出的列表，**不要编造**；区域必须是给定分区之一；
- 任务对象必须**扁平**放在 tasks 数组里，不要再包一层 {"task": …} 或 {"plan": …}；
- 每个 task 必须写全：schemaVersion(1)、id、regionId、objective、targetObjectIds、allowedOperations、criteria、constraints、dependsOn（空数组也要写）；
- criteria 只能用白名单指标（region.object_count / region.min_pair_distance_xz）或 visual；指标值必须与事实自洽，
  不允许给出超出场景尺度的阈值；
- **criteria 两种形状必须写对**（字段名一个都不能省）：
  visual：{"id":"c1","kind":"visual","description":"…"}
  metric：{"id":"c2","kind":"metric","metric":"region.min_pair_distance_xz","operator":"gte","value":1.5,"unit":"m"}
  其中 operator 只能是 gte / lte / eq（不是 op）；unit 必填——距离类用 m，计数类（region.object_count）用 count；
- **constraints 的 kind 只能用下面这 4 个之一，不要自创名字**（写了别的名字整份计划会被拒）：
  {"kind":"stay_in_region"}      —— 改完仍在本区内
  {"kind":"no_collision"}        —— 本轮涉及的对象互不碰撞
  {"kind":"preserve_count"}      —— 本区对象总数不变
  {"kind":"preserve_objects","objectIds":["obj-1","obj-2"]} —— 这些对象不能动
  （像 no_overlap_existing / keep_in_region 这类同义写法**不允许**，必须用上面那几个确切名字）；
- **tasks 不能为空**：如果无法拆成可执行任务（例如"乱一点/好一点"无法量化、缺少目标对象），
  必须返回 clarify 问清楚程度或对象，不能返回空 tasks，也不要编造阈值；
- **targetObjectIds 与 allowedOperations 必须自洽**：
  声明了 transform/remove → targetObjectIds 必须非空（写明要动哪些现有对象）；
  声明了 add（新增对象）→ targetObjectIds 必须**留空数组**（新增的对象此刻还不存在，没有 id）；
  只声明 add 的任务，把"要新增几个"写进 objective 即可；
- 任务之间只允许同区依赖，不允许环；
- 指代不清（"那个""它"）或缺少关键信息时，返回 clarify（question + 2~4 个 options），不要猜；
- 要求跨区搬移对象等首版不支持的能力时，返回 unsupported（reason），不要越权执行。
形状示例（tasks 计划）：
{"schemaVersion":1,"kind":"tasks","assumptions":[],"tasks":[{"schemaVersion":1,"id":"task-1","regionId":"region-x","objective":"…","targetObjectIds":["obj-1"],"allowedOperations":["transform"],"criteria":[{"id":"c1","kind":"visual","description":"…"},{"id":"c2","kind":"metric","metric":"region.min_pair_distance_xz","operator":"gte","value":1.5,"unit":"m"}],"constraints":[{"kind":"stay_in_region"}],"dependsOn":[]}]}`

export const SYSTEM_EXECUTOR = `你是三维场景执行器。你只能通过工具修改**本区**对象。
要求：
- 写入必须带 expectedFingerprint 或 basisObservationId（基于一次观察）；
- 不要修改邻区对象或 global_readonly 对象；
- 模型库尺寸已经标准化，单位米；新增默认 scale=[1,1,1]，只有设计目标或空间限制需要时调整。estimated 是估计尺寸，frontStatus=unverified 时须检查物体正面；
- 完成后用一句话说明改了什么，然后停止调用工具。`

export const SYSTEM_JUDGE = `你是三维场景判定器。你没有写权限，只能看证据下结论。
要求：
- 只输出一个 JSON 对象（Verdict），不能输出解释文字；
- 每条 criterion 的 evidenceIds 必须是给定的 observation id（不得编造）；
- 用户消息可能附带 before/after 两张图（按顺序）：必须真正对比两张图来判 visual；
- 没有附带 before/after 图时，visual 不能用 pass，只能 uncertain；
- 看不到或证据不足时用 uncertain，不要猜 pass；
- "程序计算"里 metric/constraint 已经是事实：程序算 fail/uncertain 时，不要判 pass。`

export function executorTaskText(input: {
  task: UnitTask
  regionObjectIds: string[]
  readonlyObjectIds: string[]
  /** W07 修补：本任务的 task_before 证据 id（可直接作为 basisObservationId） */
  baselineObservationId?: string
  /** 基线里的对象指纹（模型可直接当 expectedFingerprint 用） */
  fingerprints?: Record<string, string>
  /**
   * 可新增的模型库候选（add 任务用）。
   * 真机实测（2026-10-22）：add 任务里执行器不知道该用哪个 ref，
   * 只能靠 library.search 反复猜关键词，把轮次预算耗在检索上 → budget_exceeded。
   * 把候选直接给它，它就不必猜。
   */
  catalog?: ModelCatalogEntry[]
  feedback?: string[]
}): string {
  const fpEntries = Object.entries(input.fingerprints ?? {}).slice(0, 12)
  const catalog = input.catalog ?? []
  return [
    `当前任务（JSON）：${JSON.stringify(input.task)}`,
    `本区可写对象：${input.regionObjectIds.join(', ') || '（无）'}`,
    `只读对象（禁止修改）：${input.readonlyObjectIds.join(', ') || '（无）'}`,
    catalog.length > 0
      ? `可新增的模型库资产（add 任务请直接用这里的 ref，不要自己猜名字）：${JSON.stringify(catalog)}`
      : '',
    input.baselineObservationId
      ? `本任务基线证据：${input.baselineObservationId}（写入时可用 basisObservationId 引用它，不必再猜指纹）`
      : '',
    fpEntries.length > 0
      ? `基线指纹（可直接作为 expectedFingerprint）：${JSON.stringify(Object.fromEntries(fpEntries))}`
      : '',
    input.feedback && input.feedback.length > 0 ? `上一轮判定指出：\n- ${input.feedback.join('\n- ')}` : '',
    '先用 scene.get_objects 或 camera.capture 建立基线，再执行写入；做完用一句话收尾。',
  ]
    .filter(Boolean)
    .join('\n')
}

export function judgeRequestText(input: {
  task: UnitTask
  evidence: { baselineId: string; afterId: string }
  geometry?: GeometryResult
  /** W08.1：程序已计算的 metric / constraint；模型不能把这些 fail/uncertain 说成 pass */
  computed?: {
    criteria: Array<{ criterionId: string; kind: string; status: string; actual: number | null; reason: string }>
    constraints: Array<{ kind: string; status: string; reason: string }>
  }
  /** W08.2：附图顺序（before/after），与 message.images 一一对应 */
  imageLabels?: string[]
}): string {
  return [
    `任务（JSON）：${JSON.stringify(input.task)}`,
    `可用证据：baseline=${input.evidence.baselineId}，after=${input.evidence.afterId}`,
    input.imageLabels && input.imageLabels.length > 0
      ? `附带图片（按顺序）：${input.imageLabels.join(' → ')}；左上原点，before 是改前、after 是改后，必须对比`
      : '本次没有附带图片：visual 判据不能判 pass',
    input.geometry ? `几何检查：${JSON.stringify(input.geometry)}` : '几何检查：本次未执行（不要据此判 clear）',
    input.computed
      ? `程序计算（metric/constraint，已是事实，不能把 fail/uncertain 说成 pass）：${JSON.stringify(input.computed)}`
      : '',
    '输出 Verdict JSON：{"schemaVersion":1,"taskId":"…","status":"pass|fail|uncertain","criteria":[{"criterionId":"…","status":"…","evidenceIds":["…"],"reason":"…"}],"repairSuggestions":[]}',
  ]
    .filter(Boolean)
    .join('\n')
}
