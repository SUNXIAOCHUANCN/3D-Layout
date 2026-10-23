#!/usr/bin/env node
/**
 * 生成数据索引（添加/删除模型或场景后运行，dev.bat 会自动先跑）：
 *   assets/models 下每个模型的 meta.json  ->  assets/models/manifest.json
 *   scenes 下每个场景的 scene.json        ->  scenes/index.json
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 3D-Layout 根目录（本脚本位于 src/scripts/ 内）
const root = fileURLToPath(new URL('../..', import.meta.url))

// ---- 模型库 manifest ----
const modelsDir = join(root, 'assets', 'models')
const models = {}
for (const entry of readdirSync(modelsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const metaPath = join(modelsDir, entry.name, 'meta.json')
  if (!existsSync(metaPath)) continue
  try {
    models[`models/${entry.name}`] = JSON.parse(readFileSync(metaPath, 'utf8'))
  } catch (e) {
    console.warn(`[gen-manifest] 跳过损坏的 ${entry.name}/meta.json：${e.message}`)
  }
}
writeFileSync(
  join(modelsDir, 'manifest.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), models }, null, 2) + '\n',
)

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
