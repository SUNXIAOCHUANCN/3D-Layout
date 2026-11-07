import { edit } from './scopedEdit'
import { useSceneStore } from '../../core/store'
import type { SceneAsset, Vec3 } from '../../core/types'
import type { AgentToolDef } from './tools'
import { getGeneratedResult, saveGeneratedResult } from './generatedResults'
import { runLog } from './runLog'

function number(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const v = args[key] ?? fallback
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Error(`${key} 必须在 ${min}–${max} 之间`)
  return v
}
function assetId(args: Record<string, unknown>): string {
  if (typeof args.assetId !== 'string' || !args.assetId) throw new Error('缺少 assetId')
  return args.assetId
}
function find(id: string): SceneAsset {
  const a = useSceneStore.getState().document?.assets.find(v => v.id === id)
  if (!a) throw new Error(`资产 ${id} 不存在`)
  return a
}
function noise(x: number, z: number, seed: number): number {
  const hash = (a: number, b: number) => {
    let h = Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(seed, 1442695041)
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295
  }
  const ix = Math.floor(x), iz = Math.floor(z)
  const smooth = (v: number) => v * v * (3 - 2 * v)
  const tx = smooth(x - ix), tz = smooth(z - iz)
  const a = hash(ix, iz) * (1 - tx) + hash(ix + 1, iz) * tx
  const b = hash(ix, iz + 1) * (1 - tx) + hash(ix + 1, iz + 1) * tx
  return (a * (1 - tz) + b * tz) * 2 - 1
}

const objectSchema = { type: 'object', properties: { assetId: { type: 'string' } }, required: ['assetId'], additionalProperties: false }
const vec3Schema = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 }

export const GENERATION_TOOLS: readonly AgentToolDef[] = [
  {
    name: 'python.execute', access: 'generate', summary: '在隔离容器运行自定义 Python',
    description: '执行 Python 标准库代码，inputs 为输入 JSON，将可序列化结果赋给 result。返回 resultId、result、stdout 和 stderr；结果较大时提供 resultId。无网络和宿主文件访问。',
    argsDoc: '{ code, inputs?, timeoutSeconds? } → { resultId, result, stdout, stderr }',
    schema: { type: 'object', required: ['code'], properties: { code: { type: 'string', maxLength: 100000 }, inputs: {}, timeoutSeconds: { type: 'number', minimum: 1, maximum: 60 } }, additionalProperties: false },
    async exec(args, ctx) {
      if (typeof args.code !== 'string' || !args.code.trim() || args.code.length > 100000) throw new Error('code 须为 1–100000 字符')
      const timeoutSeconds = number(args, 'timeoutSeconds', 30, 1, 60)
      let response: Response
      try {
        response = await fetch('/api/llm-agent-python/execute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: args.code, inputs: args.inputs ?? null, timeoutSeconds }), signal: ctx.signal })
      } catch (e) {
        if (ctx.signal?.aborted) throw new Error('Python 执行已取消')
        throw new Error(`Python 服务不可用：${e instanceof Error ? e.message : String(e)}`)
      }
      const data = await response.json() as { ok?: boolean; error?: string; result?: unknown; stdout?: string; stderr?: string }
      if (!response.ok || !data.ok) throw new Error(`Python 执行失败：${data.error ?? `HTTP ${response.status}`}${data.stdout ? `\nstdout: ${data.stdout}` : ''}${data.stderr ? `\nstderr: ${data.stderr}` : ''}`)
      ctx.signal?.throwIfAborted()
      const resultId = saveGeneratedResult(data.result, ctx.contextId)
      runLog.event('python.result', { resultId, result: data.result })
      const encoded = JSON.stringify(data.result)
      return { resultId, result: encoded && encoded.length > 16000 ? '[结果过大，可使用 resultId 引用]' : data.result, stdout: data.stdout, stderr: data.stderr }
    },
  },
  {
    name: 'terrain.create_heightfield', access: 'write', summary: '根据高度数组创建地形',
    description: '使用高度数组创建地形；可以传入 Python 的 resultId，其 result 须为包含 width、depth、samplesX、samplesZ、heights 的对象。heights 按 z 行 x 列排列。',
    argsDoc: '{ pythonResultId? | width, depth, samplesX, samplesZ, heights, position?, name? }',
    schema: { type: 'object', anyOf: [{ required: ['pythonResultId'] }, { required: ['width', 'depth', 'samplesX', 'samplesZ', 'heights'] }], properties: { pythonResultId: { type: 'string' }, width: { type: 'number', minimum: 1, maximum: 1000 }, depth: { type: 'number', minimum: 1, maximum: 1000 }, samplesX: { type: 'integer', minimum: 2, maximum: 257 }, samplesZ: { type: 'integer', minimum: 2, maximum: 257 }, heights: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 66049 }, position: vec3Schema, name: { type: 'string' } }, additionalProperties: false },
    exec(args, ctx) {
      if (!ctx.tx) throw new Error('地形生成需要编辑事务')
      let values = args
      if (args.pythonResultId !== undefined) {
        if (typeof args.pythonResultId !== 'string') throw new Error('pythonResultId 必须是字符串')
        const result = getGeneratedResult(args.pythonResultId, ctx.contextId)
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Python 结果必须是高度场对象')
        values = { ...result as Record<string, unknown>, ...args }
      }
      const width = number(values, 'width', NaN, 1, 1000), depth = number(values, 'depth', NaN, 1, 1000)
      const samplesX = number(values, 'samplesX', NaN, 2, 257), samplesZ = number(values, 'samplesZ', NaN, 2, 257)
      if (!Number.isInteger(samplesX) || !Number.isInteger(samplesZ)) throw new Error('采样数必须是整数')
      if (!Array.isArray(values.heights) || values.heights.length !== samplesX * samplesZ || !values.heights.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 10000)) throw new Error('heights 长度须等于采样数乘积，高度须为 -10000–10000 的有限数字')
      const position = values.position ?? [0, 0, 0]
      if (!Array.isArray(position) || position.length !== 3 || !position.every(n => typeof n === 'number' && Number.isFinite(n))) throw new Error('position 必须为三个有限数字')
      if (values.name !== undefined && typeof values.name !== 'string') throw new Error('name 必须为字符串')
      const id = `terrain-${crypto.randomUUID()}`
      const terrain = { width, depth, samplesX, samplesZ, heights: [...values.heights] as number[], seed: 0 }
      if (!edit.addAsset({ id, ref: 'generated/terrain', name: (values.name as string | undefined) ?? '地形', terrain, transform: { position: position as Vec3, rotation: [0, 0, 0] } }, { source: 'agent', tx: ctx.tx })) throw new Error('添加地形失败')
      return { assetId: id, width, depth, samplesX, samplesZ }
    },
  },
  {
    name: 'terrain.generate', access: 'write', summary: '按参数生成高度场地形',
    description: '创建高度场地形。尺寸单位为米，随机种子使同一参数产生相同地形；地形加入场景事务，不自动移动其他对象。',
    argsDoc: '{ width?, depth?, samples?, amplitude?, noiseScale?, octaves?, edgeFalloff?, seed?, position?, name? }',
    schema: { type: 'object', properties: { width: { type: 'number', minimum: 1, maximum: 1000 }, depth: { type: 'number', minimum: 1, maximum: 1000 }, samples: { type: 'integer', minimum: 2, maximum: 257 }, amplitude: { type: 'number', minimum: 0, maximum: 100 }, noiseScale: { type: 'number', minimum: 0.01, maximum: 50, description: '跨越地形的噪声格数，越大起伏越密' }, octaves: { type: 'integer', minimum: 1, maximum: 6 }, edgeFalloff: { type: 'number', minimum: 0, maximum: 1 }, seed: { type: 'integer', minimum: -2147483648, maximum: 2147483647 }, position: vec3Schema, name: { type: 'string' } }, additionalProperties: false },
    exec(args, ctx) {
      if (!ctx.tx) throw new Error('地形生成需要编辑事务')
      const width = number(args, 'width', 20, 1, 1000), depth = number(args, 'depth', 20, 1, 1000)
      const samples = number(args, 'samples', 65, 2, 257), amplitude = number(args, 'amplitude', 2, 0, 100), scale = number(args, 'noiseScale', 3, 0.01, 50), seed = number(args, 'seed', 0, -2147483648, 2147483647)
      if (!Number.isInteger(samples) || !Number.isInteger(seed)) throw new Error('samples 与 seed 必须是整数')
      const p = args.position ?? [0, 0, 0]
      if (!Array.isArray(p) || p.length !== 3 || !p.every(n => typeof n === 'number' && Number.isFinite(n))) throw new Error('position 必须为三个有限数字')
      if (args.name !== undefined && typeof args.name !== 'string') throw new Error('name 必须为字符串')
      const octaves = number(args, 'octaves', 1, 1, 6)
      const edgeFalloff = number(args, 'edgeFalloff', 0, 0, 1)
      if (!Number.isInteger(octaves)) throw new Error('octaves 必须是整数')
      const heights: number[] = []
      for (let z = 0; z < samples; z++) for (let x = 0; x < samples; x++) {
        const u = x / (samples - 1), v = z / (samples - 1)
        let sum = 0, weights = 0
        for (let octave = 0; octave < octaves; octave++) {
          const frequency = 2 ** octave
          const weight = 1 / frequency
          sum += noise(u * scale * frequency, v * scale * frequency, seed + octave) * weight
          weights += weight
        }
        const edge = 2 * Math.min(u, v, 1 - u, 1 - v)
        const blend = edgeFalloff ? Math.min(1, edge / edgeFalloff) : 1
        heights.push(sum / weights * amplitude * blend * blend * (3 - 2 * blend))
      }
      const id = `terrain-${crypto.randomUUID()}`
      const terrain = { width, depth, samplesX: samples, samplesZ: samples, heights, seed }
      if (!edit.addAsset({ id, ref: 'generated/terrain', name: (args.name as string | undefined) ?? '地形', terrain, transform: { position: p as Vec3, rotation: [0, 0, 0] } }, { source: 'agent', tx: ctx.tx })) throw new Error('添加地形失败')
      return { assetId: id, width, depth, samples, amplitude, noiseScale: scale, seed }
    },
  },
  {
    name: 'terrain.sample', access: 'read', summary: '查询地形世界坐标高度',
    description: '查询地形网格表面高度；支持地形沿 Y 轴旋转及正缩放，超出范围返回 null。',
    argsDoc: '{ assetId, points: [[x,z], ...] }',
    schema: { type: 'object', required: ['assetId', 'points'], properties: { assetId: { type: 'string' }, points: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } } } }, additionalProperties: false },
    exec(args) {
      const a = find(assetId(args)), t = a.terrain
      if (!t) throw new Error('对象不是地形')
      const [rx, ry, rz] = a.transform.rotation, [sx, sy, sz] = a.transform.scale ?? [1, 1, 1]
      if (rx !== 0 || rz !== 0 || sx <= 0 || sy <= 0 || sz <= 0) throw new Error('查询需要 X/Z 旋转为 0 且缩放为正')
      if (!Array.isArray(args.points) || args.points.length < 1 || args.points.length > 100) throw new Error('points 须包含 1–100 个坐标')
      const angle = ry * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle), [px, py, pz] = a.transform.position
      return { assetId: a.id, heights: args.points.map(point => {
        if (!Array.isArray(point) || point.length !== 2 || !point.every(n => typeof n === 'number' && Number.isFinite(n))) throw new Error('每个点须为 [x,z] 有限数字')
        const dx = point[0] - px, dz = point[1] - pz
        let u = ((c * dx - s * dz) / sx / t.width + 0.5) * (t.samplesX - 1)
        let v = ((s * dx + c * dz) / sz / t.depth + 0.5) * (t.samplesZ - 1)
        if (u < -1e-9 || v < -1e-9 || u > t.samplesX - 1 + 1e-9 || v > t.samplesZ - 1 + 1e-9) return null
        u = Math.max(0, Math.min(t.samplesX - 1, u)); v = Math.max(0, Math.min(t.samplesZ - 1, v))
        const x = Math.min(Math.floor(u), t.samplesX - 2), z = Math.min(Math.floor(v), t.samplesZ - 2), fx = u - x, fz = v - z
        const h = (i: number, j: number) => t.heights[j * t.samplesX + i]
        const a0 = h(x, z), b = h(x + 1, z), cc = h(x, z + 1), d = h(x + 1, z + 1)
        const local = fx + fz <= 1 ? a0 + fx * (b - a0) + fz * (cc - a0) : d + (1 - fz) * (b - d) + (1 - fx) * (cc - d)
        return py + local * sy
      }) }
    },
  },
  {
    name: 'material.get', access: 'read', summary: '查询对象材质覆盖', description: '查询指定对象的实例级材质覆盖；null 表示使用原始材质。', argsDoc: '{ assetId }', schema: objectSchema,
    exec(args) { const a = find(assetId(args)); return { assetId: a.id, materialOverride: a.materialOverride ?? null } },
  },
  {
    name: 'material.apply', access: 'write', summary: '生成并应用实例 PBR 材质', description: '对单个对象的所有网格应用独立 PBR 材质，不更改其他实例的共享材质。', argsDoc: '{ assetId, color, roughness, metalness }',
    schema: { type: 'object', required: ['assetId', 'color'], properties: { assetId: { type: 'string' }, color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }, roughness: { type: 'number', minimum: 0, maximum: 1 }, metalness: { type: 'number', minimum: 0, maximum: 1 } }, additionalProperties: false },
    exec(args, ctx) {
      if (!ctx.tx) throw new Error('材质修改需要编辑事务')
      const id = assetId(args); const target = find(id)
      if (target.terrain?.surface) throw new Error('分层地形请使用 terrain.surface 工具；先 reset 才能整体覆盖')
      if (typeof args.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(args.color)) throw new Error('color 必须为 #RRGGBB')
      const materialOverride = { color: args.color, roughness: number(args, 'roughness', 0.65, 0, 1), metalness: number(args, 'metalness', 0, 0, 1) }
      if (!edit.updateAsset(id, { materialOverride }, { source: 'agent', tx: ctx.tx })) throw new Error('应用材质失败')
      return { assetId: id, materialOverride }
    },
  },
  {
    name: 'material.reset', access: 'write', summary: '恢复对象原始材质', description: '清除指定对象的实例级材质覆盖。', argsDoc: '{ assetId }', schema: objectSchema,
    exec(args, ctx) {
      if (!ctx.tx) throw new Error('材质修改需要编辑事务')
      const id = assetId(args); const target = find(id)
      if (target.terrain?.surface) throw new Error('分层地形请使用 terrain.surface 工具；先 reset 才能整体覆盖')
      if (!edit.updateAsset(id, { materialOverride: undefined }, { source: 'agent', tx: ctx.tx })) throw new Error('恢复材质失败')
      return { assetId: id, materialOverride: null }
    },
  },
]
