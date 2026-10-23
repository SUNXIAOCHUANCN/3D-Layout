# 模型库

每个模型一个文件夹：`models/<model-id>/`

| 文件 | 说明 |
|---|---|
| `meta.json` | 必需，模型档案（见下） |
| `model.glb` | `source.type = "glb"` 时必需 |
| `thumb.png` | 可选缩略图（二期资产库 UI 用） |

增删模型后运行 `pnpm gen-manifest`（`scripts\dev.bat` 会自动先跑）刷新 `manifest.json`。

## 归一化约定（入库前处理）

- 1 单位 = 1 米；+Y 向上；原点在**底面中心**。
- 建议用 Blender 批量处理后导出 glb；需要压缩时用 DRACO，解码器放 `assets/decoders/`，并在 meta 里 `"source": { "type": "glb", "file": "model.glb", "draco": true }`。

## 占位模型（primitive）

`source.type = "primitive"` 时不需要 glb 文件：渲染器按 `meta.dimensions` 生成 box/cylinder/sphere 占位几何，便于在没有真实模型时先搭建、调试场景（scene.json 里用 `tint` 可临时改色，最终尺寸 = dimensions × transform.scale）。
