# 批量模型打标产物

本目录包含 262 个模型的标准化与打标结果，全部处理成功。`tags.csv` 是汇总表；每个 `AF-*` 子目录对应一个模型。

## 单模型产物

- `model/`：标准化后的 GLB 模型。
- `thumbnail/`：模型预览图和遮罩图。
- `tags.json`：物体名称、语义类别、外观标签与风格等打标结果。
- `machine_features.json`：几何与模型特征。
- `validation.json`：处理和校验状态。
- `source.json`：原始文件信息、哈希值及标准化参数。
- `layout_manifest.json`：产物索引、坐标系、尺寸与布局信息。
- `process.log.json`：处理状态、时间和警告记录。

## 路径说明

`source.json` 中的 `source_path` 是相对于输入根目录 `samples/models/models` 的路径，例如 `treedead1-2/model.glb`。若需按此路径查找原始模型，请同时交付该输入目录并保留内部目录结构。标准化模型已包含在各自的 `model/` 子目录中。

## 使用说明

请先查看 `tags.csv` 浏览和筛选模型标签。每个 `AF-*` 目录内包含对应的标准化模型及详细标签，可按需使用。若要查找原始模型，请按上方路径说明一并获取输入模型目录。