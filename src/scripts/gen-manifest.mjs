#!/usr/bin/env node
/**
 * 生成数据索引（添加/删除模型或场景后运行，dev.bat 会自动先跑）：
 *   assets/models 下的标准资产包 + assets/builtin-models.json -> assets/model-catalog.json
 *   也可读取旧 meta.json，便于替换前验证；不会改写模型目录。
 *   scenes 下每个场景的 scene.json        ->  scenes/index.json
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildModelCatalog, readBuiltinModels } from './model-catalog.mjs'

// 3D-Layout 根目录（本脚本位于 src/scripts/ 内）
const rootArg = process.argv.indexOf('--root')
const root = rootArg >= 0 ? resolve(process.argv[rootArg + 1]) : fileURLToPath(new URL('../..', import.meta.url))

// ---- 模型库 manifest ----
const modelsDir = join(root, 'assets', 'models')
const catalog = buildModelCatalog(modelsDir, readBuiltinModels(root))
const models = catalog.models
const catalogPath = join(root, 'assets', 'model-catalog.json')
let previous = null
try { previous = JSON.parse(readFileSync(catalogPath, 'utf8')) } catch { /* 首次生成或旧文件不可读 */ }
// generatedAt 每次运行都会变：其余内容一致时保留旧文件，避免每次启动都弄脏工作区。
const unchanged = previous !== null &&
  JSON.stringify({ ...previous, generatedAt: null }) === JSON.stringify({ ...catalog, generatedAt: null })
if (!unchanged) writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n')

// ---- 场景索引 ----
const scenesDir = join(root, 'scenes')
const scenes = []
for (const entry of readdirSync(scenesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const scenePath = join(scenesDir, entry.name, 'scene.json')
  if (!existsSync(scenePath)) continue
  try {
    const doc = JSON.parse(readFileSync(scenePath, 'utf8'))
    scenes.push({ id: doc.meta?.id ?? entry.name, name: doc.meta?.name ?? entry.name })
  } catch (e) {
    console.warn(`[gen-manifest] 跳过损坏的 ${entry.name}/scene.json：${e.message}`)
  }
}
scenes.sort((a, b) => a.id.localeCompare(b.id))
writeFileSync(join(scenesDir, 'index.json'), JSON.stringify(scenes, null, 2) + '\n')

console.log(`[gen-manifest] ${Object.keys(models).length} models, ${scenes.length} scenes`)
