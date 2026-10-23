import { defineConfig } from 'vite'

// UI 独立构建：浏览器转换路径（GLTFLoader/GLTFExporter 需要浏览器图片解码）。
// 产物 ui-dist/ 由插件本地服务静态伺服，不依赖宿主 Vite。
export default defineConfig({
  root: 'ui',
  base: '/',
  build: {
    outDir: '../ui-dist',
    emptyOutDir: true,
    target: 'es2022',
  },
})
