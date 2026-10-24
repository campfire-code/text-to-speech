# 第三方开源组件

本工具使用了以下开源组件，许可证原文见各项目仓库。

| 组件 | 用途 | 许可证 |
|---|---|---|
| [Tauri](https://github.com/tauri-apps/tauri) 及官方插件 | 桌面应用框架 | MIT / Apache-2.0 |
| [React](https://github.com/facebook/react) | 界面 | MIT |
| [Lucide](https://github.com/lucide-icons/lucide) | 图标 | ISC |
| [Vite](https://github.com/vitejs/vite) | 构建 | MIT |
| [FFmpeg](https://ffmpeg.org) 6.x 静态构建（取自 [eugeneware/ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) b6.1.1；Windows 版来自 gyan.dev） | 音视频处理，作为独立程序随应用分发 | GPL-3.0（许可证随安装包附在 licenses/ffmpeg-LICENSE.txt；源码见 https://ffmpeg.org/download.html） |
| [exceljs](https://github.com/exceljs/exceljs) | 读取 Excel / CSV 文案 | MIT |
| [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) v2.0.0 的 WebAssembly 构建（`src/tool/tts/vendor/`，文件来源与校验值见该目录 README.md） | 在应用内离线运行语音合成模型 | Apache-2.0 |
| [hexgrad/Kokoro-82M-v1.1-zh](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh) 语音模型（ONNX 转换版取自 [csukuangfj/kokoro-multi-lang-v1_1](https://huggingface.co/csukuangfj/kokoro-multi-lang-v1_1)） | 文字转语音；首次使用时下载到本机，不随安装包分发 | Apache-2.0（模型卡标注；中文训练数据由龙猫数据授权） |
