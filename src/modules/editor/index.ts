/**
 * 编辑器模块（B · 人工编辑）—— 可整体拆卸。
 * 对外两个装配点 + 一个装配钩子：
 *   装配点①（Canvas 内）： <EditorGizmo />        作为 SceneCanvas 的 children
 *   装配点②（左侧边栏）：  <EditorPanel />         挂在插件侧边栏的插件面板槽位
 *   装配钩子：            useEditorModule(enabled)
 * 全部修改经 core/edit（source: 'human'）；模块关闭 = 不订阅交互事件 = 纯渲染器。
 */
export { EditorGizmo } from './EditorGizmo'
export { EditorPanel } from './EditorPanel'
export { useEditorModule } from './useEditorModule'
