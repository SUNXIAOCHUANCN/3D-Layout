import { useSceneStore } from '../../../core/store'
import type { Partition } from '../types'
export function partition(): Partition {
  return { regions: [
    { id: 'left', name: '左区', design: '森林', polygon: [[-10, -10], [0, -10], [0, 10], [-10, 10]] },
    { id: 'right', name: '右区', design: '村落', polygon: [[0, -10], [10, -10], [10, 10], [0, 10]] },
  ], owners: { a: 'left', b: 'right' }, workflowId: 'wf', workflowRevision: 1, runId: 'run', createdAt: '' }
}
export function scene() {
  useSceneStore.setState({ sceneId: 'test', document: {
    meta: { id: 'test', name: 'test', version: 1, unit: 'm', up: '+Y' }, environment: {}, cameras: [],
    assets: [
      { id: 'a', ref: 'test', transform: { position: [-5, 0, 0], rotation: [0, 0, 0] } },
      { id: 'b', ref: 'test', transform: { position: [5, 0, 0], rotation: [0, 0, 0] } },
    ],
  } })
}
