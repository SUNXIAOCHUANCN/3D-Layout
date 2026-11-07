# 3D-Layout 持久化后端

场景、撤销栈、重做栈一起保存到 SQLite。刷新页面或切换场景后恢复完整工作区；人工编辑与 AI 编辑共用同一保存入口。

默认 AI 编辑任务现由后端调度并保存记录。刷新后自动重新连接，恢复对话、工具进度及待确认草稿；浏览器工具断线时等待重连。设计、边界及接口见 [AI 任务持久化与重连](../develop-guide/AI任务持久化与重连.md)。CoAgent 运行时仍独立于该任务服务。

## 环境

- Node.js **22.18 或更新版本**，使用内置 `node:sqlite`，无需安装数据库服务。
- npm 或 pnpm。以下命令从 `3D-Layout/src` 执行。
- 本版本面向本地单用户，可打开多个标签页；版本冲突会拒绝覆盖。

Node 22 可能输出 SQLite 实验性 API 提示，不影响运行。

## 开发启动

```powershell
npm.cmd install
npm.cmd run gen-manifest
npm.cmd run dev
```

打开终端显示的地址。Vite 自动挂载同一套持久化 API，不需要再启动后端进程。导入导出插件仍是独立服务，按原入口启动。

## 构建后启动

```powershell
npm.cmd run build
npm.cmd run server
```

默认地址 `http://127.0.0.1:5173`。独立服务同时提供构建页面、`assets/`、`scenes/` 和工作区 API。不要让开发服务与独立服务同时维护同一个工作目录。

配置项：

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| `PORT` | `5173` | 独立服务端口 |
| `LAYOUT_ROOT` | `3D-Layout/` | 数据根目录，包含 `assets/`、`scenes/`、`.data/`；独立模式还需 `src/dist/` |
| `LAYOUT_BROWSER` | Windows Edge 默认安装路径 | 浏览器测试的 Chrome/Edge 可执行文件 |

独立服务绑定回环地址，未实现账号和远程访问鉴权，不应直接作为公网服务部署。人工 Agent 与 CoAgent 的调用日志接口也使用共享后端，在开发模式与独立服务中均可用。

## 使用

1. 第一次读取已有场景时，自动从 `scenes/<id>/scene.json` 初始化数据库。
2. 人工拖动松开、属性修改或 AI 事务提交后自动保存。拖动过程只在内存预览。
3. 顶栏显示“保存中”“已保存”“离线待保存”“版本冲突”或“保存失败”。
4. 刷新同一标签页后恢复场景、撤销历史和重做状态。未提交内容先写 IndexedDB，网络恢复后可重试。
5. 遇到冲突，先“导出本地副本”，再按需“重新加载”；放弃本地修改前有确认。

浏览器本地队列按标签页身份隔离。不要在待保存时清理站点数据或关闭标签页；关闭后新建标签页不保证自动找回原标签页队列。写入 IndexedDB 失败时保留内存副本并提示错误，应先导出。刷新前浏览器可能提示尚有未保存内容。

“已保存”表示后端已确认。`scene.json` 是数据库的文件投影，兼容现有渲染绑定和导出插件；投影失败会显示提示，后续读取或提交时重试。场景进入数据库后，手改旧 `scene.json` 不会覆盖数据库；修改应通过界面或工作区 API 完成。

## API

所有路径相对于页面来源。工作区写请求要求 `Content-Type: application/json` 和 `X-Layout-Client: 1`；浏览器跨来源写入会被拒绝。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/health` | 健康检查与数据库结构版本 |
| GET | `/api/scenes` | 场景列表，自动发现新导入的场景目录 |
| GET | `/api/workspaces/:id` | 返回 `{ revision, workspace, projectionError }` |
| POST | `/api/workspaces/:id` | 原子提交文档和编辑历史 |
| GET | `/api/workspaces/:id/history?before=100&limit=50` | 版本记录，按版本倒序；limit 为 1–100 |
| POST | `/api/workspaces/:id/restore` | 将旧版本恢复为一个新版本 |
| POST | `/api/log` | 保存 Agent Markdown 日志 `{ filename, content }` |
| GET | `/api/log/list` | 列出 Agent 日志 |
| POST | `/api/coagent-log` | 保存 CoAgent Markdown 日志 `{ filename, content }` |

提交体：

```json
{
  "requestId": "client-generated-uuid",
  "baseRevision": 0,
  "label": "移动椅子",
  "workspace": {
    "document": {},
    "journal": [],
    "redoStack": [],
    "txCounter": 0
  }
}
```

`document` 应传完整 `SceneDocument`，上例的 `{}` 仅表示字段位置，不能直接提交。正常使用时由前端生成整个请求。

响应示例：`{ "revision": 1, "projectionError": null }`。相同 `requestId` 和相同请求内容重试只返回原提交结果；相同 ID 不同内容或 `baseRevision` 过期返回 409。参数/历史不一致返回 400，跨来源写入返回 403，场景或版本不存在返回 404，请求超过 32 MiB 返回 413。

恢复请求：

```json
{ "requestId": "another-uuid", "baseRevision": 8, "revision": 3 }
```

恢复后产生版本 9，保留旧版本记录，新工作区撤销/重做栈为空。恢复接口当前供工具或程序调用，未增加版本管理页面。

## 数据与备份

```text
.data/layout.sqlite           数据库
.data/layout.sqlite-wal       SQLite 运行文件，不要手动删除
.data/layout.sqlite-shm       SQLite 运行文件，不要手动删除
.data/backups/                默认数据库备份目录
assets/                      GLB、贴图和模型元数据
scenes/<id>/scene.json        当前文档投影
scenes/<id>/threejs/view.json 渲染配置
```

数据库使用 `PRAGMA user_version` 管理结构迁移，当前为版本 1；高于服务支持版本的数据库会拒绝打开。版本记录保留完整工作区，资源引用覆盖当前文档和撤销/重做历史。本版不自动删除历史或模型，避免破坏恢复能力。

运行在线数据库备份：

```powershell
npm.cmd run backup
# 指定备份目录
npm.cmd run backup -- "D:\layout-backups"
```

备份使用 SQLite Backup API，不能只复制运行中的主数据库文件来代替。数据库备份不包含 GLB、贴图、渲染配置和浏览器待提交队列。

完整备份建议：等待“已保存”，停止所有写入进程，备份数据库及 `assets/`、`scenes/`。恢复时关闭 Vite、独立服务和导入插件，另存现有 `.data/` 后，用备份替换 `.data/layout.sqlite`，移走旧数据库配套的 `-wal`、`-shm` 文件，再恢复同批资源和场景目录，最后启动并检查场景、历史及模型加载。

## 测试

```powershell
npm.cmd run test:backend
npm.cmd run test:backend-browser
npm.cmd run test:coagent
npm.cmd run build
```

后端和浏览器测试使用临时数据库、场景和浏览器配置，不修改真实场景。Windows 浏览器测试退出后如果配置目录仍被浏览器子进程占用，会报告临时路径，稍后可清理。

更详细的数据流和约束见 [技术设计](../develop-guide/后端持久化技术设计.md)。
