# threejs-interchange — 3D-Layout 导入导出插件

把外部 Three.js 场景转换成 **3D-Layout 原生场景 + 全局模型库资产**的自包含本地插件。
宿主源码零改动（独立模式）；磁盘原生格式就是集成接口。实现依据
`develop-guide/ThreeJS双向导入导出插件架构设计.md`（v3）与 `ThreeJS场景导入规范.md`。

## 能力（一期 A）

- **导入**：`layout-import.json`（显式声明：场景 ID、坐标单位/向上轴、模型 key/名称/分类、
  实例 ID/modelKey/变换）+ 每模型一个**自包含静态 GLB** → 确定性转换（米制/+Y/底面中心，
  实例矩阵按 `W_target = C·W·N⁻¹` 补偿）→ 服务端独立复核 → 事务化入库到
  `scenes/<id>/` 与 `assets/models/<scene.id>-<model.key>/` → 调用宿主 `gen-manifest.mjs`
  刷新索引 → 新标签页 `?scene=<id>` 打开。
- **导出**：场景原生交换包（`.layout.zip`，工程相对路径 + 逐文件 SHA-256）与单模型包。
- **拒绝**：蒙皮/morph/视频纹理/Draco·KTX2 压缩/外部资源引用/剪切·镜像·奇异变换 ——
  一期不做静默降级，报告给出来源与建议。

## 使用

```bash
cd plugins/threejs-interchange
pnpm install
pnpm build        # 构建 UI（浏览器转换路径需要）
pnpm start        # 默认 root=工程上一级、端口 5175；-- --port 5176 --root <path>
```

打开 http://127.0.0.1:5175 ：

1. **导入页**：选择 `layout-import.json` + 模型 GLB（或一个 zip）→ 转换预览 →
   上传暂存（服务端独立复核）→ 提交入库 → 点"在宿主中打开"。
2. **导出页**：选场景/模型 → 下载包。
3. **森林示例**（不写真实工程时自动进临时沙箱）：

```bash
pnpm cli:demo-forest            # dry-run 到临时目录
pnpm cli:demo-forest -- --yes   # 写入真实工程（scenes/demo-forest + assets/models/demo-forest-*）
```

静态托管/离线安装：prepare 下载的候选 zip 也可以用 CLI 安装：

```bash
pnpm cli:install -- --zip candidate.zip [--root <工程根>] [--conflict suffix-hash]
```

## 部署约束与代价（架构文档 §2/§7.2，已明示）

- **单写入者**：安装期间不要并行导入、运行 gen-manifest 或手动改目标目录。
  插件锁只约束本插件，不是全局文件锁。
- 安装窗口内不要刷新宿主/切场景；已打开的旧标签页看不到新模型，重开即见。
- 只创建新场景；不合并当前场景、不读未保存内存状态、导出只针对磁盘已保存内容。
- 无强原子可见性（多目录 + 两个索引）；进程中断后服务启动时按恢复日志回滚。

## 布局

```
application/   契约、校验、命名、纯数据 GLB 检查器（浏览器/服务端共用）
adapters/three/    规范化数学 + 浏览器转换管线（GLTFLoader/GLTFExporter）
adapters/layout/   原生 scene.json/meta.json/view.json 组装
server/        本地服务：prepare/jobs/commit/cancel、文件事务、导出打包
ui/            独立操作界面（Vite 构建到 ui-dist/）
cli/           离线安装器 + demo-forest 生成器
sdk/           一期 B：外部 Three.js 应用导出入口（待实现）
tests/         单测 + 沙箱端到端（绝不写真实工程）
```

## 与宿主的两个集成缝（已验证）

1. `?scene=<id>`：`src/App.tsx` boot 时读取并加载对应场景（新标签页打开即生效）。
2. `src/scripts/gen-manifest.mjs`：无依赖 Node 脚本，插件在提交事务内调用并做
   **包含性核验**（新模型/新场景条目已出现且与暂存内容一致；manifest 含
   generatedAt，不做整文件字节对比）。失败按恢复日志回滚，复用资产不误删。

## 清理示例

删除 `scenes/demo-forest/`、`assets/models/demo-forest-*`，重新运行
`pnpm gen-manifest`（宿主 src 下）即可完全移除示例。
