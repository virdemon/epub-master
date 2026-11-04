# EPUB Master

一个**纯本地**的 EPUB 排版整理与压缩工具。文件在你的设备上解包、重排、打包，不联网、不上传。

提供两个端，各有一套界面，共用同一套 EPUB 处理思路：

| 端 | 定位 | 形态 |
| --- | --- | --- |
| **电脑版** | 排版整理 + 压缩 + 分卷，功能完整 | 网页版 / Windows 桌面版 |
| **安卓版** | 只做压缩，极简操作 | Android APK |

---

## 电脑版

把一本排版失控的 EPUB 处理成「手机、墨水屏、平板、电脑上看起来一样」的版本，体积压到能接受的上限以内，装不下就按章节拆成多卷。

### 三种处理模式

模式不是换个名字，引擎行为真的不同：

| 模式 | 行为 |
| --- | --- |
| **标准优化** | 保留原书 CSS 与内联样式，只把 `px`/`pt` 绝对单位换算成相对单位（这是「同一本书在不同设备上字号不一样」的根因），只修真正坏掉的结构 |
| **深度优化** | 用统一样式表替代原 CSS，统一字号/行高/缩进；清空段落、去内联样式、限制图片最长边 1600、移除内嵌字体 |
| **极致压缩** | 在深度优化基础上进一步降分辨率（最长边 1200、画质 0.70），清理未被引用的资源 |

### 主要能力

- **排版标准化** — 向阅读器里那种 TXT 观感看齐：正文铺满版面、窄边距、行距 1.6、段距 0.5em、首行缩进 2em
- **EPUB 2.0 / 3.0 规范化** — 可保留原版本，也可显式转换
- **图片压缩** — JPG / PNG / WebP 重编码，按目标尺寸降采样解码（避免大图整张进内存）
- **重复图片清理** — SHA-256 与像素双重判重，只删「确定相同」的，不确定的一律保留；删的是显示位置，不是资源文件
- **按章节自动分卷** — 先压图片，压不下去才分卷
- **结构诊断与修复** — 处理「此文件未列在 manifest 文件中」这类损坏书
- **处理前后预览** — 原书渲染 vs 处理后渲染，另有图片浏览
- **输出完整性检查** — 写出后重新解包校验目录、OPF、manifest、spine、XHTML、CSS、图片引用

### 固定约束

- **原始 EPUB 永远只读**，所有处理都在临时工作副本上完成，输出另存为新文件
- 不删章节、不改正文内容、不擅自改 EPUB 版本

---

## 安卓版

只保留压缩这一件事，界面按手机习惯重新设计，不是电脑版的缩小版。

**流程**：选 EPUB → 选模式 → 压缩 → 保存

| 模式 | 参数 |
| --- | --- |
| 推荐 | JPEG 0.85，长边上限 2000 |
| 高质量 | JPEG 0.92，不缩分辨率（安全上限 3000） |
| 强力压缩 | JPEG 0.70，长边上限 1400 |

**特点**

- 输出保存到 `下载/EPUB Master/原文件名_compressed.epub`
- Android 10+ 走 MediaStore 写入，不需要存储权限，不会因父目录不存在失败
- 分块桥接传输（`begin → writeChunk × N → finish`），大文件不会因单次传输超限失败
- 压缩全程不碰 OPF / NCX / mimetype，EPUB 2.0 进就是 EPUB 2.0 出
- 逐张异步处理 + 真实进度 + 可取消，不卡界面
- GIF / SVG 等不能安全重编码的格式自动跳过

---

## 目录结构

```
epubfix/                电脑版网页应用
  index.html            界面
  app.js                交互层
  style.css             样式
  src/core.js           EPUB 处理引擎（约 5000 行，纯 JS + 浏览器 API）
  vendor/fflate.js      ZIP 处理

desktop/                Electron 桌面壳
  main.js               主进程
  preload.js            预加载桥接

installer/              Windows 安装程序（NSIS）
migrate/                缓存迁移脚本（bat）

mobile/                 安卓版（Capacitor）
  www/                  前端资源
    index.html
    app.js
    style.css
    src/core-compress.js  精简压缩引擎
    native-bridge.js      原生保存桥接（esbuild 打包产物）
  native-bridge-src.js  桥接源码
  android/              Android 工程
    app/src/main/java/com/epubmaster/app/
      MainActivity.java          返回键拦截 + 插件注册
      DownloadSaverPlugin.java   MediaStore 分块写入插件

tools/                  造样书、打包、校验等构建脚本
test/                   回归测试脚本
```

---

## 本地运行

### 网页版

直接用浏览器打开 `epubfix/index.html`，无需构建、无需服务器。

### 桌面版

```bash
cd desktop
# 需要先有 Electron 环境
electron .
```

### 安卓版

```bash
cd mobile
npm install

# 修改前端后重新打包原生桥接
npx esbuild native-bridge-src.js --bundle --format=iife --target=es2017 --outfile=www/native-bridge.js

# 同步 web 资源到 Android 工程
npx cap sync android

# 构建 APK（需要 JDK 21 + Android SDK）
cd android
./gradlew assembleRelease
```

产物在 `mobile/android/app/build/outputs/apk/release/`。

> 构建签名 APK 需要自己的 keystore，仓库中不包含任何签名密钥。

---

## 测试

```bash
# 压缩引擎结构完整性（Node 环境，不需要浏览器）
node test/verify_compress_core.js

# 图片压缩真实效果（需要 Chromium / Edge）
node test/verify_browser_compress.js

# 分块传输字节完整性
node test/verify_chunk_transfer.js

# 安卓端完整流程（真实浏览器驱动）
node test/verify_e2e.js
```

---

## 技术栈

- **纯 JS**，无框架。EPUB 引擎用 `fflate` 解包，自写 ZIP 打包（CompressionStream + CRC32）
- **图片处理**基于 `createImageBitmap` + `canvas` / `OffscreenCanvas` + `toBlob`，全部为标准浏览器 API
- **桌面版** Electron
- **安卓版** Capacitor 8 + 自写原生插件（MediaStore 写入）

---

## 已知限制

- 依赖 `CompressionStream`，缺失时回退 fflate（体积略大但可用）
- 安卓版真机保存路径在部分定制系统上可能与标准「下载」目录不同
- 加密 EPUB（DRM）不支持，按设计跳过

---

## 许可

MIT
