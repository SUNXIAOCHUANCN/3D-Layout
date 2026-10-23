/** 校验器单测：声明 schema、路径安全、限额、zip 条目归一化 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { validateLayoutImport, isSafeRelPath, validateCandidateEntries, normalizeZipEntryPath } from '../application/validation.js'

const good = {
  schemaVersion: 1,
  profile: 'layout-static-v1',
  scene: { id: 'demo-forest', name: '森林' },
  coordinates: { metersPerUnit: 0.01, up: '+Z', handedness: 'right' },
  models: [{ key: 'pine', name: '松树', file: 'models/pine.glb' }],
  instances: [{ id: 'pine-1', modelKey: 'pine', transform: { position: [1, 0, 0] } }],
}

test('合法声明通过校验', () => {
  const r = validateLayoutImport(good)
  assert.equal(r.ok, true)
})

test('缺资产声明 → MISSING_ASSET_DECLARATION（不默认拆分、不猜测）', () => {
  const r = validateLayoutImport({ ...good, instances: [] })
  assert.equal(r.ok, false)
  if (!r.ok) assert.ok(r.issues.some(i => i.code === 'MISSING_ASSET_DECLARATION'))
})

test('缺单位声明 → 拒绝（不可猜测）', () => {
  const r = validateLayoutImport({ ...good, coordinates: undefined })
  assert.equal(r.ok, false)
  if (!r.ok) assert.ok(r.issues.some(i => i.code === 'INVALID_DECLARATION'))
})

test('schemaVersion 错误拒绝', () => {
  const r = validateLayoutImport({ ...good, schemaVersion: 99 })
  assert.equal(r.ok, false)
})

test('modelKey 重复拒绝', () => {
  const r = validateLayoutImport({
    ...good,
    models: [
      { key: 'pine', name: 'A', file: 'models/a.glb' },
      { key: 'pine', name: 'B', file: 'models/b.glb' },
    ],
  })
  assert.equal(r.ok, false)
})

test('实例引用未声明 modelKey 拒绝', () => {
  const r = validateLayoutImport({ ...good, instances: [{ id: 'x', modelKey: 'ghost', transform: { position: [0, 0, 0] } }] })
  assert.equal(r.ok, false)
})

test('实例负缩放/非有限数拒绝', () => {
  const r = validateLayoutImport({ ...good, instances: [{ id: 'x', modelKey: 'pine', transform: { position: [0, 0, 0], scale: [-1, 1, 1] } }] })
  assert.equal(r.ok, false)
  const r2 = validateLayoutImport({ ...good, instances: [{ id: 'x', modelKey: 'pine', transform: { position: [NaN, 0, 0] } }] })
  assert.equal(r2.ok, false)
})

test('危险路径全部拒绝', () => {
  for (const p of ['../etc/passwd', '/abs/path', 'C:/win', 'a\\b', 'a/../b', './x', '', 'a//b']) {
    assert.equal(isSafeRelPath(p), false, `应拒绝：${p}`)
  }
  assert.equal(isSafeRelPath('models/pine.glb'), true)
  assert.equal(isSafeRelPath('assets/hdri/studio.hdr'), true)
})

test('候选包条目：顶层白名单 + 重复 + 大小写碰撞', () => {
  const ok = validateCandidateEntries([
    { path: 'scenes/a/scene.json', bytes: 10 },
    { path: 'assets/models/a/meta.json', bytes: 10 },
    { path: 'import/layout-import.json', bytes: 10 },
  ])
  assert.equal(ok.length, 0)

  const dup = validateCandidateEntries([
    { path: 'scenes/a/scene.json', bytes: 10 },
    { path: 'scenes/a/scene.json', bytes: 10 },
  ])
  assert.ok(dup.some(i => i.code === 'DUPLICATE_ENTRY'))

  const collide = validateCandidateEntries([
    { path: 'scenes/A/scene.json', bytes: 10 },
    { path: 'scenes/a/scene.json', bytes: 10 },
  ])
  assert.ok(collide.some(i => i.code === 'CASE_COLLISION'))

  const evil = validateCandidateEntries([{ path: 'evil/scene.json', bytes: 10 }])
  assert.ok(evil.some(i => i.code === 'PATH_UNSAFE'))
})

test('zip 条目路径归一化：穿越/盘符/反斜杠', () => {
  assert.equal(normalizeZipEntryPath('a/b.txt'), 'a/b.txt')
  assert.equal(normalizeZipEntryPath('/abs/a.txt'), 'abs/a.txt')
  assert.equal(normalizeZipEntryPath('..\\evil.txt'), null)
  assert.equal(normalizeZipEntryPath('C:\\x.txt'), null)
  // 任何 .. 段一律拒绝（纵使语义上可归一化——zip 条目不允许穿越，防御优先）
  assert.equal(normalizeZipEntryPath('a/./b/../c.txt'), null)
  assert.equal(normalizeZipEntryPath('a/./b/c.txt'), 'a/b/c.txt')
  assert.equal(normalizeZipEntryPath('dir/'), null)
})
