import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react'
import { SceneCanvas } from './components/SceneCanvas'
import { bus } from './core/events'
import { loadSceneIndex } from './core/loader'
import { useSceneStore } from './core/store'
import type { SceneIndexEntry } from './core/types'
import { AgentPanel, AgentPickHighlight, useAgentModule, useAgentStore } from './modules/agent'
import { AgentPanel as NewAgentPanel, AgentPickHighlight as NewAgentPickHighlight, useAgentModule as useNewAgentModule, useAgentStore as useNewAgentStore } from './modules/llm-agent'
import { CoAgentBridge, CoAgentPanel, deriveHostLocks, useCoAgentModule } from './modules/coagent'
import { PartitionAgentPanel, usePartitionAgentModule, usePartitionAgentStore } from './modules/partition-agent'
import { EditorGizmo, EditorPanel, useEditorModule } from './modules/editor'
import { HistorySidebar } from './modules/history/HistorySidebar'
import { InterchangePanel } from './modules/interchange/InterchangePanel'
import { LoadingOverlay } from './ui/LoadingOverlay'
import { Sidebar } from './ui/Sidebar'
import { TopBar } from './ui/TopBar'

// 侧边栏宽度（可拖拽调整，localStorage 记忆）
const SIZE_KEY = 'ui-sidebar-size-v1'
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

function loadSizes(): { left: number; right: number } {
  const LEFT_DEFAULT = 258
  const RIGHT_DEFAULT = 240
  try {
    const raw = localStorage.getItem(SIZE_KEY)
    const v = raw ? (JSON.parse(raw) as { left?: number; right?: number }) : {}
    return {
      left: typeof v.left === 'number' ? clamp(v.left, 208, 520) : LEFT_DEFAULT,
      right: typeof v.right === 'number' ? clamp(v.right, 208, 420) : RIGHT_DEFAULT,
    }
  } catch {
    return { left: LEFT_DEFAULT, right: RIGHT_DEFAULT }
  }
}

export default function App() {
  const boot = useSceneStore(s => s.boot)
  const sceneDoc = useSceneStore(s => s.document)
  const sceneError = useSceneStore(s => s.sceneError)
  const view = useSceneStore(s => s.view)
  const [scenes, setScenes] = useState<SceneIndexEntry[]>([])
  // 编辑器模块开关：URL ?editor=0/1 > 场景 view.json 的 editor.enabled > 默认开
  const urlEditor = new URLSearchParams(location.search).get('editor')
  const [editorOn, setEditorOn] = useState(urlEditor !== '0')
  // Agent 模块开关：默认开；传输层由 ?agent= 决定（缺省=浏览器直连 LLM）
  const [agentOn, setAgentOn] = useState(true)
  const [newAgentOn, setNewAgentOn] = useState(false)
  const [partitionAgentOn, setPartitionAgentOn] = useState(false)
  const partitionAgentBusy = usePartitionAgentStore(s => s.busy)
  // 导入导出插件入口（独立本地工具,开关仅控制本面板显隐）
  const [interchangeOn, setInterchangeOn] = useState(true)
  // CoAgent 模块开关：多区自动布局；活跃时暂停人工编辑与旧 Agent（写者互斥）
  const [coagentOn, setCoagentOn] = useState(true)
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)
  const [sizes, setSizes] = useState(loadSizes)
  // Agent 任务预览期（提案执行/等待裁决）暂停人工编辑：防止双写者搅同一本账
  const agentPhase = useAgentStore(s => s.phase)
  const newAgentPhase = useNewAgentStore(s => s.phase)
  // CoAgent：唯一 runtime 装配（isHostBusy 传稳定引用，内部不进 hook 依赖）
  const hostBusyRef = useRef(() => useAgentStore.getState().phase !== 'idle' || useNewAgentStore.getState().phase !== 'idle' || usePartitionAgentStore.getState().busy)
  const coagent = useCoAgentModule(coagentOn, { isHostBusy: hostBusyRef.current })
  // 写者互斥的唯一判断来源（SPEC §1.4 清单，单测 + T13 实跑覆盖）
  const locks = deriveHostLocks({ editorEnabled: editorOn, agentBusy: agentPhase !== 'idle' || newAgentPhase !== 'idle' || partitionAgentBusy, coagentPhase: coagent.phase })
  const manualEditing = locks.manualEditing

  useEffect(() => {
    void (async () => {
      let list: SceneIndexEntry[] = []
      try {
        list = await loadSceneIndex()
      } catch {
        // index 缺失不致命，boot 会兜底尝试默认场景
      }
      setScenes(list)
      const param = new URLSearchParams(location.search).get('scene')
      const initial = list.find(s => s.id === param)?.id ?? list[0]?.id ?? 'scene-01'
      await boot(initial)
    })()
  }, [boot])

  // view.json 在场景加载后才可用；URL 参数已显式指定时不覆盖
  useEffect(() => {
    if (urlEditor === '0' || urlEditor === '1') return
    setEditorOn(view.editor?.enabled !== false)
  }, [view, urlEditor])

  // 场景新建/删除后重拉场景索引（顶栏下拉的数据源）
  useEffect(
    () =>
      bus.on('scene:index-changed', () => {
        void loadSceneIndex()
          .then(setScenes)
          .catch(() => {
            /* 索引缺失不致命：下拉保留旧列表 */
          })
      }),
    [],
  )

  useEffect(() => {
    try {
      localStorage.setItem(SIZE_KEY, JSON.stringify(sizes))
    } catch {
      /* 写不进就算了 */
    }
  }, [sizes])

  /** 侧栏拖宽：左栏向右增、右栏向左增 */
  const startResize = (side: 'left' | 'right') => (e: ReactMouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = side === 'left' ? sizes.left : sizes.right
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX
      setSizes(s =>
        side === 'left'
          ? { ...s, left: clamp(startW + dx, 208, 520) }
          : { ...s, right: clamp(startW - dx, 208, 420) },
      )
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  useEditorModule(manualEditing, editorOn || agentOn || newAgentOn || partitionAgentOn)
  useAgentModule(agentOn && locks.agentModuleEnabled)
  useNewAgentModule(newAgentOn && locks.agentModuleEnabled)
  usePartitionAgentModule(partitionAgentOn && locks.agentModuleEnabled)

  const leftStyle: CSSProperties = { width: sizes.left }
  const rightStyle: CSSProperties = { width: sizes.right }

  return (
    <div className="app">
        <TopBar scenes={scenes} locked={locks.sceneSwitchLocked} />
      <div className="main">
        <Sidebar
          style={leftStyle}
          collapsed={leftCollapsed}
          onToggle={() => setLeftCollapsed(v => !v)}
          plugins={[
            {
              id: 'manual-editor',
              name: '人工编辑',
              description: '变换 · 属性 · 保存',
              enabled: manualEditing,
              onToggle: () => setEditorOn(v => !v),
              panel: <EditorPanel />,
            },
            {
              id: 'llm-agent',
              name: 'AI 编辑',
              description: '对话式布局修改',
              enabled: agentOn,
              onToggle: () => { setAgentOn(v => !v); if (!agentOn) { setNewAgentOn(false); setPartitionAgentOn(false) } },
              panel: <AgentPanel />,
            },
            {
              id: 'llm-agent-experiment',
              name: 'LLM Agent 实验',
              description: '新链路 · 规划与预算',
              enabled: newAgentOn,
              onToggle: () => { setNewAgentOn(v => !v); if (!newAgentOn) { setAgentOn(false); setPartitionAgentOn(false) } },
              panel: <NewAgentPanel />,
            },
            {
              id: 'partition-agent',
              name: '场景分区 Agent',
              description: '鸟瞰分区 · 并行编辑',
              enabled: partitionAgentOn,
              onToggle: () => { setPartitionAgentOn(v => !v); if (!partitionAgentOn) { setAgentOn(false); setNewAgentOn(false) } },
              panel: <PartitionAgentPanel />,
            },
            {
              id: 'interchange',
              name: '导入导出',
              description: '外部场景与模型包',
              enabled: interchangeOn,
              onToggle: () => setInterchangeOn(v => !v),
              panel: <InterchangePanel />,
            },
            {
              id: 'coagent',
              name: 'CoAgent 布局',
              description: '多区自动布局',
              enabled: coagentOn,
              onToggle: () => setCoagentOn(v => !v),
              panel: <CoAgentPanel coagent={coagent} />,
            },
          ]}
        />
        {!leftCollapsed && <div className="vresize" onMouseDown={startResize('left')} title="拖拽调整宽度" />}
        <div className="viewport">
          {sceneDoc ? (
            <SceneCanvas>
              {manualEditing && <EditorGizmo />}
              {agentOn && <AgentPickHighlight />}
              {newAgentOn && <NewAgentPickHighlight />}
              {/* W04：CoAgent 渲染端口（独立相机 + 离屏捕获），关插件即卸载并释放离屏资源 */}
              {coagentOn && <CoAgentBridge runtime={coagent.runtime} />}
            </SceneCanvas>
          ) : (
            <div className="empty-state">{sceneError ?? '正在加载场景…'}</div>
          )}
          <LoadingOverlay />
        </div>
        {!rightCollapsed && <div className="vresize" onMouseDown={startResize('right')} title="拖拽调整宽度" />}
        <HistorySidebar style={rightStyle} collapsed={rightCollapsed} onToggle={() => setRightCollapsed(v => !v)} locked={locks.historyLocked} />
      </div>
    </div>
  )
}
