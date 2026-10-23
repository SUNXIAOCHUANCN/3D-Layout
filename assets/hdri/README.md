# HDRI 环境贴图

把 `.hdr` 文件放在本目录，然后在场景的 `scene.json` 里引用：

```json
"environment": { "hdri": "assets/hdri/studio-01.hdr" }
```

未配置时渲染器使用程序化生成的 RoomEnvironment（零下载、离线可用）。
贴图来源推荐 Poly Haven（https://polyhaven.com/hdris），选 1k/2k 分辨率即可。
