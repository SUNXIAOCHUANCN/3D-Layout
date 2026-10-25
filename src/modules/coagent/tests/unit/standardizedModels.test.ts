import { describe, expect, it } from 'vitest'
import { Box3, Euler, Matrix4, Quaternion, Vector3 } from 'three'
import { modelWorldBounds } from '../../../../shared/modelBounds'
import { searchLibrary } from '../../tools/sceneTools'
import { footprintAabbXZ } from '../../services/validation'
import type { WorkflowContext } from '../../contracts'

describe('standardized assets', () => {
  it('meter bounds follow Three XYZ, mirrored scales, and offset origins', () => {
    const model = { dimensions: { w: 2, h: 3, d: 4 }, bounds: { min: [-1, .1, -2] as [number, number, number], max: [1, 3.1, 2] as [number, number, number] } }
    const transform = { position: [5, 6, 7] as [number, number, number], rotationDeg: [25, 80, -30] as [number, number, number], scale: [-2, 3, 4] as [number, number, number] }
    const matrix = new Matrix4().compose(new Vector3(...transform.position), new Quaternion().setFromEuler(new Euler(...transform.rotationDeg.map(x => x * Math.PI / 180) as [number, number, number], 'XYZ')), new Vector3(...transform.scale))
    const expected = new Box3(new Vector3(...model.bounds.min), new Vector3(...model.bounds.max)).applyMatrix4(matrix)
    const actual = modelWorldBounds(model, transform)
    actual.min.forEach((x, i) => expect(x).toBeCloseTo(expected.min.toArray()[i], 10))
    actual.max.forEach((x, i) => expect(x).toBeCloseTo(expected.max.toArray()[i], 10))
    const footprint = footprintAabbXZ(transform, { ...model, name: 'Tree', ref: 'models/tree', category: null })!
    expect(footprint.minX).toBeCloseTo(expected.min.x, 10)
    expect(footprint.maxZ).toBeCloseTo(expected.max.z, 10)
  })

  it('search uses workflow descriptions and tags even when IDs are opaque', () => {
    const entry = { ref: 'models/AF-123', name: '水杯', category: '用品', dimensions: { w: .1, h: .15, d: .1 }, description: '透明玻璃容器', tags: ['蓝色'], retrievalTerms: ['喝水'], scaleStatus: 'estimated', frontStatus: 'unverified' }
    const context = { editorRead: { snapshot: () => ({ catalog: [entry] }) } } as unknown as WorkflowContext
    for (const query of ['透明', '蓝色', '喝水']) expect(searchLibrary(context, query, 5).entries).toEqual([entry])
  })
})
