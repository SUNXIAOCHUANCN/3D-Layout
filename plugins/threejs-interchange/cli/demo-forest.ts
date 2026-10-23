/**
 * demo-forest 森林示例生成器（架构文档 §11 一期 A 验收："先以显式声明的
 * 森林示例验证场景与语义模型目录真正落盘"）。
 *
 * 全链路确定性、无大模型：
 *   three 合成低多边形模型 → GLB（GLTFExporter）
 *   → layout-import.json 声明（一个模型故意用 +Z up / 厘米，验证坐标换算）
 *   → convertImport（一期浏览器转换管线，Node 下无纹理模型可跑）
 *   → prepare → commit 事务化入库
 *
 * 用法：pnpm cli:demo-forest [-- --root <工程根>] [--yes]
 * 默认 dry-run 到临时目录；--yes 才写入真实工程。
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BufferGeometry, ConeGeometry, CylinderGeometry, Group, IcosahedronGeometry, Mesh, MeshStandardMaterial } from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { zipSync } from 'fflate'
import { convertImport } from '../adapters/three/convert.js'
import type { LayoutImport } from '../application/contracts.js'
import { validateLayoutImport } from '../application/validation.js'
import { JobStore } from '../server/jobs.js'
import { acquireInstallLock, commitJob } from '../server/install.js'
import { textBytes } from '../application/digest.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

// GLTFExporter 在 Node 下需要浏览器 FileReader（读 Blob）；Node 有原生 Blob，桥接即可。
// 注意它使用 onloadend 回调（源码 GLTFExporter.js:697/731/1306）。
// 仅无纹理模型可走此路径 —— 与"首版采用浏览器转换路径"的分工一致，此处只为验收脚本。
if (typeof (globalThis as unknown as { FileReader?: unknown }).FileReader === 'undefined') {
  class FileReaderShim {
    result: unknown = null
    onload: (() => void) | null = null
    onloadend: (() => void) | null = null
    onerror: (() => void) | null = null
    private fire(): void {
      this.onload?.()
      this.onloadend?.()
    }
    readAsArrayBuffer(blob: Blob): void {
      blob.arrayBuffer().then(b => { this.result = b; this.fire() }, () => this.onerror?.())
    }
    readAsDataURL(blob: Blob): void {
      blob.arrayBuffer().then(b => {
        this.result = `data:application/octet-stream;base64,${Buffer.from(b).toString('base64')}`
        this.fire()
      }, () => this.onerror?.())
    }
  }
  ;(globalThis as unknown as { FileReader: unknown }).FileReader = FileReaderShim
}

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(arg('root') ?? resolve(pluginDir, '..', '..'))
const yes = process.argv.includes('--yes')

// ---------- 合成模型（低多边形，无纹理 → Node 可导出） ----------

function buildPineTree(): Group {
  const g = new Group()
  const trunk = new Mesh(
    new CylinderGeometry(0.08, 0.12, 1.2, 8),
    new MeshStandardMaterial({ color: 0x7a5230, roughness: 0.9 }),
  )
  trunk.name = 'trunk'
  trunk.position.y = 0.6
  const crownLow = new Mesh(
    new ConeGeometry(1.1, 1.6, 9),
    new MeshStandardMaterial({ color: 0x2f6b3a, roughness: 0.85 }),
  )
  crownLow.name = 'crown-low'
  crownLow.position.y = 1.9
  const crownTop = new Mesh(
    new ConeGeometry(0.75, 1.3, 9),
    new MeshStandardMaterial({ color: 0x3c7f47, roughness: 0.85 }),
  )
  crownTop.name = 'crown-top'
  crownTop.position.y = 3.0
  g.add(trunk, crownLow, crownTop)
  return g
}

function buildBush(): Group {
  const g = new Group()
  const blob = new Mesh(
    new IcosahedronGeometry(0.5, 1),
    new MeshStandardMaterial({ color: 0x4e8c3f, roughness: 0.95, flatShading: true }),
  )
  blob.name = 'bush'
  blob.position.y = 0.42
  blob.scale.set(1.2, 0.85, 1.2)
  g.add(blob)
  return g
}

function exportGlb(object: Group): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    new GLTFExporter().parse(object, r => resolve(r as ArrayBuffer), reject, { binary: true, onlyVisible: false })
  })
}

// ---------- 声明（覆盖验收表坐标用例：米/+Y 与 厘米/+Z 混合来源） ----------

function buildDeclaration(): LayoutImport {
  // 整个源场景声明为厘米 + Z-up（常见 DCC 导出形态），验证验收表
  // "厘米、Z-up、非底部原点 → 世界位置和实际尺寸在容差内保持"。
  // 所有坐标数值均为源单位（厘米）。
  const cm = (m: number): number => m * 100
  return {
    schemaVersion: 1,
    profile: 'layout-static-v1',
    scene: { id: 'demo-forest', name: 'Demo Forest（导入验收示例）' },
    coordinates: { metersPerUnit: 0.01, up: '+Z', handedness: 'right' },
    models: [
      { key: 'pine-tree', name: '松树', category: 'vegetation', tags: ['tree', 'pine'], file: 'models/pine-tree.glb', license: 'CC0' },
      { key: 'bush', name: '灌木', category: 'vegetation', tags: ['bush'], file: 'models/bush.glb', license: 'CC0' },
    ],
    instances: [
      // 源是 +Z-up：地面是 XY 平面，z 分量是高度（全部贴地 0）
      ...Array.from({ length: 8 }, (_, i) => {
        const angle = (i / 8) * Math.PI * 2
        const s = 0.8 + (i % 4) * 0.15
        return {
          id: `pine-${i + 1}`,
          modelKey: 'pine-tree',
          name: `松树 ${i + 1}`,
          transform: {
            position: [cm(Math.cos(angle) * 8 + (i % 3) * 0.7), cm(Math.sin(angle) * 8), 0] as [number, number, number],
            // 源是 Z-up：绕源 +Z 轴旋转
            rotation: [0, 0, (i * 47) % 360] as [number, number, number],
            scale: [s, s, s] as [number, number, number],
          },
          visible: true,
        }
      }),
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `bush-${i + 1}`,
        modelKey: 'bush',
        name: `灌木 ${i + 1}`,
        transform: {
          position: [cm(Math.cos(i * 1.7) * 4.2), cm(Math.sin(i * 1.7) * 4.2), 0] as [number, number, number],
          rotation: [0, 0, i * 90] as [number, number, number],
          scale: [1.1, 1, 1.1] as [number, number, number],
        },
        visible: true,
      })),
    ],
    camera: { id: 'main-camera', position: [cm(14), cm(14), cm(9)], target: [0, 0, cm(1.5)], fov: 50 },
    environment: { background: '#87a9c9', sunIntensity: 1.2, ground: { size: [cm(40), cm(40)], receiveShadow: true } },
    view: { cameraId: 'main-camera', grid: { enabled: true } },
    options: { conflict: 'reject' },
  }
}

// ---------- 主流程 ----------

async function main(): Promise<void> {
  const declaration = buildDeclaration()
  const declCheck = validateLayoutImport(declaration)
  if (!declCheck.ok) {
    throw new Error(`内置声明非法（编程错误）：${declCheck.issues.map(i => i.message).join('；')}`)
  }

  console.log('[demo-forest] 1/5 合成模型并导出 GLB…')
  const pineGlb = await exportGlb(buildPineTree())
  const bushGlb = await exportGlb(buildBush())

  console.log('[demo-forest] 2/5 浏览器转换管线（Node 无纹理路径）…')
  const declBytes = textBytes(JSON.stringify(declaration, null, 2) + '\n')
  const out = await convertImport({
    declaration,
    declarationBytes: declBytes,
    files: new Map([
      // 两个模型都包上 厘米 + Z-up 的根变换，与声明的源坐标系一致
      ['models/pine-tree.glb', wrapAsCentimeterZUp(new Uint8Array(pineGlb))],
      ['models/bush.glb', wrapAsCentimeterZUp(new Uint8Array(bushGlb))],
    ]),
  })
  const blocking = out.issues.filter(i => i.severity === 'error')
  if (blocking.length > 0) throw new Error(`转换被阻断：${blocking.map(i => `[${i.code}] ${i.message}`).join('；')}`)
  for (const m of out.plan.models) {
    console.log(`  模型 ${m.key} → ${m.dir}（${m.dimensions.w.toFixed(2)}×${m.dimensions.h.toFixed(2)}×${m.dimensions.d.toFixed(2)} m）`)
  }
  console.log(`  实例 ${out.plan.instanceCount} 个，候选文件 ${out.plan.files.length} 个`)

  const targetRoot = yes ? root : mkdtempSync(join(tmpdir(), 'demo-forest-'))
  if (!yes) console.log(`[demo-forest] dry-run：写入沙箱 ${targetRoot}（加 --yes 写入真实工程 ${root}）`)
  // 沙箱需要最小宿主结构 + gen-manifest
  const { mkdirSync, copyFileSync, existsSync, writeFileSync } = await import('node:fs')
  mkdirSync(join(targetRoot, 'scenes'), { recursive: true })
  mkdirSync(join(targetRoot, 'assets', 'models'), { recursive: true })
  mkdirSync(join(targetRoot, 'src', 'scripts'), { recursive: true })
  if (!existsSync(join(targetRoot, 'scenes', 'index.json'))) {
    writeFileSync(join(targetRoot, 'scenes', 'index.json'), '[]\n')
  }
  if (!existsSync(join(targetRoot, 'assets', 'models', 'manifest.json'))) {
    writeFileSync(join(targetRoot, 'assets', 'models', 'manifest.json'), JSON.stringify({ generatedAt: '', models: {} }, null, 2) + '\n')
  }
  const hostScript = resolve(pluginDir, '..', '..', 'src', 'scripts', 'gen-manifest.mjs')
  copyFileSync(hostScript, join(targetRoot, 'src', 'scripts', 'gen-manifest.mjs'))

  console.log('[demo-forest] 3/5 打包候选集…')
  const files: Record<string, Uint8Array> = {}
  for (const [p, b] of out.candidateFiles) files[p] = b
  const zip = zipSync(files, { level: 6 })

  console.log('[demo-forest] 4/5 prepare（服务端独立复核）…')
  const dataDir = process.env.INTERCHANGE_DATA_DIR ?? join(pluginDir, '.data')
  const store = new JobStore(targetRoot, dataDir)
  const job = store.prepare(zip, 'reject')
  if (job.issues.some(i => i.severity === 'error')) {
    throw new Error(`复核发现阻断问题：${job.issues.filter(i => i.severity === 'error').map(i => i.message).join('；')}`)
  }

  console.log('[demo-forest] 5/5 commit 事务入库…')
  const lock = acquireInstallLock(dataDir)
  try {
    store.save({ ...job, state: 'committing' })
    const result = commitJob({
      root: targetRoot,
      jobDir: join(dataDir, 'jobs', job.id),
      sceneId: job.sceneId,
      files: job.files,
      newModelRefs: job.newModelRefs,
      expectedMetas: new Map(Object.entries(job.metas)),
      payloadDir: join(dataDir, 'jobs', job.id, 'payload'),
    })
    const { writeState } = await import('../server/install.js')
    writeState(join(dataDir, 'jobs', job.id), { ...store.get(job.id), state: 'committed', result })
    console.log(`[demo-forest] 完成：场景 ${result.sceneId}，新增 ${result.added.length} 文件，复用 ${result.reused.length}`)
    if (yes) {
      console.log(`[demo-forest] 打开：http://localhost:5173/?scene=${result.sceneId}`)
    } else {
      console.log(`[demo-forest] 沙箱产物保留在 ${targetRoot}，可手动检查后删除`)
    }
  } finally {
    lock.release()
  }
}

/** 给 GLB 场景根挂 Rx(-90°)·S(100) 矩阵，模拟"厘米 + Z-up"来源数据：
 *  源空间点 p(cm,Z-up) 经 N 换算后应与原米制模型重合（模长 1/100，Z→Y）。 */
function wrapAsCentimeterZUp(glb: Uint8Array): Uint8Array {
  // 解析 GLB → 改 JSON chunk → 重打包
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength)
  const jsonLen = dv.getUint32(12, true)
  const jsonText = new TextDecoder().decode(glb.subarray(20, 20 + jsonLen))
  const gltf = JSON.parse(jsonText) as { nodes?: Array<Record<string, unknown>>; scenes?: Array<{ nodes?: number[] }> }
  const roots = gltf.scenes?.[0]?.nodes ?? []
  const s = 100
  // column-major：Rx(+90°)·S(100)：Y(树高)→+Z（+Z-up 源里树立在地面上方）
  const matrix = [
    s, 0, 0, 0,
    0, 0, s, 0,
    0, -s, 0, 0,
    0, 0, 0, 1,
  ]
  for (const ri of roots) {
    gltf.nodes![ri]!['matrix'] = matrix
    delete gltf.nodes![ri]!['translation']
    delete gltf.nodes![ri]!['rotation']
    delete gltf.nodes![ri]!['scale']
  }
  const newJson = new TextEncoder().encode(JSON.stringify(gltf))
  // GLB 规范：chunk 起始按 4 字节对齐（GLTFExporter 会给 JSON 补空格）
  const binLen = dv.getUint32(20 + Math.ceil(jsonLen / 4) * 4, true)
  const binStart = 20 + Math.ceil(jsonLen / 4) * 4 + 8
  const bin = glb.subarray(binStart, binStart + binLen)
  const jsonPadded = Math.ceil(newJson.length / 4) * 4
  const total = 12 + 8 + jsonPadded + 8 + bin.length
  const out = new Uint8Array(total)
  const odv = new DataView(out.buffer)
  odv.setUint32(0, 0x46546c67, true)
  odv.setUint32(4, 2, true)
  odv.setUint32(8, total, true)
  // 声明填充后的长度：GLTFLoader r186 的 chunk 遍历不做对齐跳步，
  // 声明真实长度 + 填充字节会让它把填充读成下一个 chunk 头（JSON 尾部空格合法）
  odv.setUint32(12, jsonPadded, true)
  odv.setUint32(16, 0x4e4f534a, true)
  out.set(newJson, 20)
  for (let i = newJson.length; i < jsonPadded; i++) out[20 + i] = 0x20
  const binOff = 20 + jsonPadded
  odv.setUint32(binOff, bin.length, true)
  odv.setUint32(binOff + 4, 0x004e4942, true)
  out.set(bin, binOff + 8)
  return out
}

main().catch(err => {
  console.error('[demo-forest] 失败：', err)
  process.exit(1)
})
