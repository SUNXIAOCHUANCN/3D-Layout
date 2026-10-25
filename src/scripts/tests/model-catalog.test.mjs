import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildModelCatalog } from '../model-catalog.mjs'

function fixture(t, dimensions = [20, 15, 20]) {
  const root = mkdtempSync(join(tmpdir(), 'layout-catalog-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const directory = join(root, 'AF-test')
  mkdirSync(join(directory, 'model'), { recursive: true })
  writeFileSync(join(directory, 'model/AF-test.glb'), 'model bytes')
  writeFileSync(join(directory, 'tags.json'), JSON.stringify({ extended_tags: ['透明'], modeling_style: 'Lowpoly', rendering_style: '卡通渲染' }))
  const manifest = { asset_id: 'AF-test', asset_version: 1, processing_status: 'ready',
    artifacts: { model: 'model/AF-test.glb', tags: 'tags.json' },
    coordinate_system: { up_axis: '+Y', unit: 'cm', front_status: 'unverified' },
    bounds: { dimensions_cm: dimensions, aabb: { min: [-10, 0, -10], max: [10, dimensions[1], 10] } },
    object_label: { display: '水杯' }, semantic_category: { path: ['用品', '容器'] },
    retrieval_profile: { description: '透明玻璃杯', terms: ['喝水'] }, scale: { status: 'estimated' } }
  const path = join(directory, 'layout_manifest.json')
  writeFileSync(path, JSON.stringify(manifest))
  return { root, path, manifest }
}

test('adapts standard dimensions/introduction with a single cm-to-m conversion and no bundle writes', t => {
  const { root, path } = fixture(t)
  const before = readFileSync(path, 'utf8')
  const meta = buildModelCatalog(root).models['models/AF-test']
  assert.deepEqual(meta.dimensions, { w: .2, h: .15, d: .2 })
  assert.equal(meta.source.unitScale, .01)
  assert.equal(meta.source.url, '/assets/models/AF-test/model/AF-test.glb')
  assert.equal(meta.name, '水杯')
  assert.equal(meta.description, '透明玻璃杯')
  assert.deepEqual(meta.tags, ['透明', '喝水'])
  assert.equal(meta.scaleStatus, 'estimated')
  assert.equal(meta.frontStatus, 'unverified')
  assert.equal(readFileSync(path, 'utf8'), before)
})

test('accepts zero-thickness surfaces', t => {
  const { root } = fixture(t, [200, 0, 200])
  assert.equal(buildModelCatalog(root).models['models/AF-test'].dimensions.h, 0)
})

test('rejects model paths escaping a bundle', t => {
  const { root, path, manifest } = fixture(t)
  manifest.artifacts.model = '../outside.glb'
  writeFileSync(path, JSON.stringify(manifest))
  assert.throws(() => buildModelCatalog(root), /Missing\/unsafe artifact/)
})

test('keeps primitive definitions external and omits failed bundles', t => {
  const { root, path, manifest } = fixture(t)
  manifest.processing_status = 'validation_failed'
  writeFileSync(path, JSON.stringify(manifest))
  const builtin = { id: 'placeholder-box', name: 'box', source: { type: 'primitive', shape: 'box' }, dimensions: { w: 1, h: 1, d: 1 } }
  const catalog = buildModelCatalog(root, { 'models/placeholder-box': builtin })
  assert.deepEqual(catalog.models, { 'models/placeholder-box': builtin })
})

test('readable folder names are independent of stable asset IDs and artifact file names', t => {
  const { root } = fixture(t)
  renameSync(join(root, 'AF-test'), join(root, 'cup'))
  const meta = buildModelCatalog(root).models['models/cup']
  assert.equal(meta.id, 'AF-test')
  assert.equal(meta.source.file, 'model/AF-test.glb')
  assert.equal(meta.source.url, '/assets/models/cup/model/AF-test.glb')
  assert.equal(meta.manifestUrl, '/assets/models/cup/layout_manifest.json')
})

test('encodes readable non-ASCII folder names in resource URLs', t => {
  const { root } = fixture(t)
  renameSync(join(root, 'AF-test'), join(root, '水杯'))
  assert.equal(buildModelCatalog(root).models['models/水杯'].source.url, `/assets/models/${encodeURIComponent('水杯')}/model/AF-test.glb`)
})

test('rejects duplicate stable identities in different folders', t => {
  const { root } = fixture(t)
  cpSync(join(root, 'AF-test'), join(root, 'duplicate'), { recursive: true })
  assert.throws(() => buildModelCatalog(root), /Duplicate asset ID/)
})
