# DRACO 解码器

模型使用 DRACO 压缩时，把以下两个文件放到本目录：

- `draco_wasm_wrapper.js`
- `draco_decoder.wasm`

来源：three.js 仓库 `examples/jsm/libs/draco/gltf/` 目录（https://github.com/mrdoob/three.js/tree/dev/examples/jsm/libs/draco/gltf）。

未放置时，meta.json 中不要开启 `"draco": true`（未压缩 glb 不需要解码器）。
