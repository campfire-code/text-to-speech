# 语音引擎文件（sherpa-onnx WebAssembly）

这三个文件原样取自 k2-fsa/sherpa-onnx v2.0.0 发行包（Apache-2.0）：

- 发行包：`sherpa-onnx-wasm-simd-2.0.0-sherpa-onnx-pocket-tts-int8-2026-01-26.tar.bz2`
  （https://github.com/k2-fsa/sherpa-onnx/releases/tag/v2.0.0 ，GitHub 显示的 SHA-256：`c4f78aa3aadff37676834c1fc37ce148c7f0163dca5ee00d06a4d42e1b6b42b7`）
- 取出的文件与 SHA-256：

| 文件 | SHA-256 |
|---|---|
| `sherpa-onnx-wasm-main-tts.js` | `f55bca1df6247a1cb6a24f92deb2436d23205b8d0b85313ae55ccceb5fd67f84` |
| `sherpa-onnx-wasm-main-tts.wasm` | `b0a84503747bbefd2e06003518ba6588edaae8e4057ad72af9c5853d231531f1` |
| `sherpa-onnx-tts.js` | `d599fa7ff065a2587f66436769116605f6c089ff63aa57b987e71d7539f637b1` |

发行包里还有一个随构建打进去的示例模型数据包（.data），**没有**放进本仓库；`tts.worker.ts` 用 `getPreloadedPackage` 把它替换成空包，改为加载 Kokoro 模型。

为什么不用 npm 包 `sherpa-onnx`：它是 Node.js 专用构建（启用了 NODERAWFS，在浏览器环境里会直接抛 "NODERAWFS is currently only supported on Node.js environment"）。
