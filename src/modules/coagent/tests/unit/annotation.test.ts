/**
 * P2 标注优先级：本轮成果必须排在环境前面。
 *
 * 旧实现把"本轮新增"拼在列表末尾再截断——区里对象一多，新加的对象根本进不了
 * 12 个标注名额，判定器只能说"看不清"。这些断言锁住的正是这个顺序。
 */

import { describe, expect, it } from 'vitest'
import { prioritizeAnnotationIds } from '../../services/annotation'

const range = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i}`)

describe('P2 标注优先级', () => {
  it('本轮新增排在环境前面，且不会被环境挤掉', () => {
    const out = prioritizeAnnotationIds(
      { created: ['new-1', 'new-2'], targets: ['target-1'], environment: range('env', 30) },
      12,
    )
    expect(out.slice(0, 3)).toEqual(['new-1', 'new-2', 'target-1'])
    expect(out).toHaveLength(12)
    // 环境只填空位
    expect(out.slice(3).every(id => id.startsWith('env'))).toBe(true)
  })

  it('顺序是 created → modified → targets → environment → readonly', () => {
    const out = prioritizeAnnotationIds({
      created: ['c1'],
      modified: ['m1'],
      targets: ['t1'],
      environment: ['e1'],
      readonly: ['r1'],
    })
    expect(out).toEqual(['c1', 'm1', 't1', 'e1', 'r1'])
  })

  it('去重时保留首次出现的位置（同一对象既是新增又是目标时算新增）', () => {
    const out = prioritizeAnnotationIds({ created: ['x'], targets: ['x'], environment: ['y'] })
    expect(out).toEqual(['x', 'y'])
  })

  it('名额小于总数时只截断尾部，不重排', () => {
    const out = prioritizeAnnotationIds({ created: ['a', 'b', 'c'], environment: ['d'] }, 2)
    expect(out).toEqual(['a', 'b'])
  })

  it('空输入返回空数组（不报错）', () => {
    expect(prioritizeAnnotationIds({})).toEqual([])
  })
})
