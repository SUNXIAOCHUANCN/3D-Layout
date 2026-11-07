# 同一地形的多材质表面

支持内置预设、自定义贴图/参数材质，以及权重、高度和噪声混合。

地形仍然是一个 SceneAsset 和一张高度场网格。可选 `terrain.surface` 保存最多四层材质和 RGBA8 权重图；旧场景继续使用原材质。内置 grass、sand、rock、snow 为离线程序化纹理，包含颜色细节、粗糙度和微表面起伏。无需下载资源。

## Agent 使用示例

先使用 `terrain.surface.get` 查询地形尺寸、高度范围和已有配置。以下写操作沿用 Agent 任务事务与现有提案提交流程。

配置材质层（重新配置会清空已有绘制）：

```json
{
  "assetId": "实际地形ID",
  "layers": [
    { "id": "grass", "presetId": "grass", "tileSize": 2 },
    { "id": "sand", "presetId": "sand", "tileSize": 2 },
    { "id": "rock", "presetId": "rock", "tileSize": 3 },
    { "id": "snow", "presetId": "snow", "tileSize": 2 }
  ],
  "baseLayerId": "grass",
  "resolution": 256
}
```

使用 `terrain.surface.apply_rules`，根据查询结果调整阈值：

```json
{
  "assetId": "实际地形ID",
  "rules": [
    { "layerId": "sand", "height": { "max": 3, "transition": 2 } },
    { "layerId": "snow", "height": { "min": 25, "transition": 4 } },
    { "layerId": "rock", "slope": { "min": 45, "transition": 8 } }
  ]
}
```

规则按数组顺序叠加，高度为局部米、坡度为局部地形坡度（度）。transition 在条件范围内部过渡；此例 25 米开始出现雪，29 米达到完整强度。绘制后修改高度不会自动重新执行规则。

使用 `terrain.surface.paint` 画沙路：

```json
{
  "assetId": "实际地形ID",
  "operations": [
    { "layerId": "sand", "shape": "path", "points": [[-8, -5], [0, 0], [8, 4]], "radius": 1.5, "feather": 0.5, "strength": 1, "space": "local" }
  ]
}
```

圆形使用 shape=circle、center=[x,z]、radius；多边形使用 shape=polygon、points。feather 从边界向内部过渡，radius 为路径半宽。默认局部坐标；paint 的 space=world 按变换后地形表面在世界 XZ 平面上的位置计算，笔刷尺寸为世界米，包含非均匀缩放。工具不会改变地形高度。

`erase=true` 仅把目标层的权重移回基础层，不影响其他层；擦除基础层无效果。

`terrain.surface.sample` 使用局部 points 查询各层权重，范围外为 null。`get` 返回 meanWeight（平均权重占比），不返回大数组。

`terrain.surface.reset` 默认移除分层配置；mode=base 清空绘制并保留图层。分层模式下 material.apply、material.reset、material.batch 会拒绝整体覆盖；移除分层配置后可继续使用。

## 保存与边界

权重图默认 256×256，最大 512×512，数据随 scene.json 保存，加载时校验版本、通道和长度。一次批量操作对应一次编辑记录，失败时不会部分修改。历史当前沿用完整数据快照；高分辨率连续操作会增加内存与场景文件大小。

第一版没有鼠标笔刷面板；最多四层；纹理采用局部 XZ 平铺，陡坡可能拉伸。规则区域为局部坐标。当前绘制内核按权重图全图遍历，尚未引入分块更新和历史差量压缩。

## 验证

在 src 目录运行：

```text
npx vitest run -c modules/terrain/vitest.config.ts
npm run build
```

浏览器验证先启动本地服务，再从项目根目录执行：

```text
node src/scripts/check_terrain_browser.mjs --url=http://127.0.0.1:5189/
```

验证页为 `/modules/terrain/tests/probe.html`，通过真实 Chrome/Edge WebGL 渲染四材质地形，记录着色器可用性、错误和截图，默认输出 artifacts/terrain-surface。此验证页不修改用户场景。

## 自定义材质与细节混合

先把贴图复制到项目 `assets/materials/<名称>/` 下，再让 Agent 使用 `/assets/materials/<名称>/...` 路径。当前提供资源引用和材质配置工具，尚无文件上传/材质库面板。资源定义保存在当前地形的 `surface.materials`，场景文件保存资源引用；分发场景时也要携带对应 assets 文件。

对已有图层调用 `terrain.surface.set_material`，可以注册并应用完整资源，而不清空绘制：

```json
{
  "assetId": "实际地形ID",
  "layerId": "grass",
  "material": {
    "id": "custom-earth",
    "name": "自定义泥土地表",
    "color": "#ffffff",
    "roughness": 0.9,
    "normalStrength": 0.7,
    "maps": {
      "color": "/assets/materials/terrain-example/color.png",
      "normal": "/assets/materials/terrain-example/normal.png",
      "roughness": "/assets/materials/terrain-example/roughness.png",
      "ao": "/assets/materials/terrain-example/ao.png",
      "height": "/assets/materials/terrain-example/height.png"
    }
  },
  "tileSize": 2
}
```

示例贴图已随代码提供，属于程序生成的验证素材。可以替换为自己的平铺地表贴图。maps 各项均可省略，只有 color 参数也能创建纯色参数化材质。基础颜色按 sRGB 转换，法线与灰度数据按线性数据处理；法线使用 OpenGL +Y，灰度贴图读取 R 通道。高度用于表面细节和权重混合，不改变网格高度。

同一资源可用 `materialId` 分配给其他图层。再次传入相同 ID 的完整 material 会替换资源，影响当前地形内所有引用它的图层；其他地形不受影响。切回预设使用 presetId。material、materialId、presetId 三项互斥。

只提供 layerId 和 tileSize/tint/roughness/normalStrength 可以修改图层参数。图层 roughness、normalStrength 优先于资源默认值；基础颜色由资源 color 与图层 tint 相乘。粗糙度贴图再乘以粗糙度参数。

也可以在 configure 时一次提供 materials、layers、blend；自定义图层提供 materialId，无需 presetId。configure 会重置绘制，而 set_material 保留绘制。

调用 `terrain.surface.set_blend`：

```json
{
  "assetId": "实际地形ID",
  "blend": {
    "mode": "height",
    "heightContrast": 6,
    "noiseStrength": 0.4,
    "noiseScale": 2,
    "seed": 42
  }
}
```

mode=weight 为基础权重混合；mode=height 在重叠区域按各材质高度细节调整权重。heightContrast 默认 4（0–16）；noiseStrength 默认 0（0–1）；noiseScale 默认 2 局部米。噪声可以在两种模式下使用。每次 set_blend 替换整组混合设置，省略参数使用默认值。保持 seed 可重复生成效果。

细节混合采用有界乘法调权再归一化，原始权重为零的材质不会凭空出现；因此完全没有重叠的硬边不会因噪声自动产生过渡，应先用 feather 或规则 transition 建立混合区域。sample 和 meanWeight 返回原始绘制权重，不包含渲染时高度/噪声的细节调权。

每个资源最多提供五类 PNG/JPEG/WebP 贴图，当前渲染统一缩放到 512×512，并打包为三张纹理，以控制四层材质的采样器数量。单文件限制 20MB，图片边长最大 8192。纹理尚未加载时显示替代材质，失败时视口显示原因；异步加载完成前截图可能包含替代效果。

自定义材质浏览器验证：

```text
node src/scripts/check_terrain_browser.mjs --custom --output=artifacts/terrain-surface/custom-browser.json
```

验证会加载所有五类示例贴图，检查着色器与资源加载错误，并比较基础权重和高度/噪声混合后的像素差异。

React StrictMode 下的实际 TerrainModel 组件验证：

```text
node src/scripts/check_terrain_browser.mjs --component --output=artifacts/terrain-surface/component-browser.json
```
