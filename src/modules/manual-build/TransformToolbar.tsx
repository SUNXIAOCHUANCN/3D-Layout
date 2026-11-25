import { useSceneStore } from '../../core/store'
import { useBuildTools } from './buildTools'
import { supportsGizmoMode, useEditorStore, type GizmoMode } from './editorStore'
import { activateGizmoMode, usePlacement } from './placement'

const MODES: { mode: GizmoMode; label: string; key: string }[] = [
  { mode: 'translate', label: '移动', key: 'W' },
  { mode: 'rotate', label: '旋转', key: 'E' },
  { mode: 'scale', label: '缩放', key: 'R' },
  { mode: 'unified', label: '复合', key: 'T' },
]

export function TransformToolbar() {
  const requested = useEditorStore(state => state.mode)
  const placing = usePlacement(state => Boolean(state.ref))
  const selecting = useBuildTools(state => state.interaction === 'select')
  const lightType = useSceneStore(state => state.document?.lights?.find(light => light.id === state.selectedLightId)?.type)
  const mode = supportsGizmoMode(requested, lightType) ? requested : 'translate'
  return <div className="build-transform-toolbar" role="group" aria-label="对象变换">
    {MODES.map(item => <button key={item.mode} type="button" className="btn"
      aria-pressed={!placing && selecting && mode === item.mode}
      title={`${item.label} (${item.key})`} aria-keyshortcuts={item.key}
      disabled={!supportsGizmoMode(item.mode, lightType)}
      onClick={() => activateGizmoMode(item.mode)}>
      {item.label}<span className="build-transform-key" aria-hidden="true">{item.key}</span>
    </button>)}
  </div>
}
