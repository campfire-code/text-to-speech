# 文案转配音

> 篝火出品 · 收录于篝火 App 应用区

离线多音色配音，免费：语音模型下载一次后在本机合成，不联网、不要显卡

![界面截图](docs/screenshot.png)

## 下载

到 [Releases](https://github.com/campfire-code/text-to-speech/releases/latest) 下载对应安装包：

| 电脑 | 文件 |
|---|---|
| Windows 10 / 11 | `text-to-speech_版本号_windows-x64-setup.exe` |
| Mac（Apple 芯片） | `text-to-speech_版本号_mac-arm64.dmg` |
| Mac（Intel 芯片） | `text-to-speech_版本号_mac-x64.dmg` |

第一次打开：
- **Windows**：如果弹出「Windows 已保护你的电脑」，点「更多信息」→「仍要运行」。
- **Mac**：如果提示「无法验证开发者」，打开「系统设置 → 隐私与安全性」，在下方点「仍要打开」。

## 怎么用

1. **输入文案**：在左侧文本框里一行写一条；或点「导入 txt / Excel…」（也可直接把文件拖进来）。txt 每行一条；csv / xlsx 读第一个可见工作表，自动选「文案 / 内容 / 台词」那一列（也可手动换列，勾选「第一行是表头」则跳过表头）。不支持旧版 .xls，请另存为 .xlsx。
2. **选声音**：音色共 103 个（中文女声 55、中文男声 45、英文女声 3），点「试听」听一小段；语速 0.6×–1.6×；句间停顿可调。中文里夹英文单词、数字、日期可以直接读。
3. **选输出**：格式 MP3（内置 ffmpeg 转码，192 kbps，单声道，24 kHz）或 WAV；「每条一个文件」或「合成一个文件」（条间停顿可调）；勾选「同时导出对齐的 SRT 字幕」。
4. 点「开始合成」。**第一次**会下载语音模型（约 388 MB，校验 SHA-256 后保存在本机应用数据目录），之后离线可用；下载不了时，可到 Hugging Face 的 `csukuangfj/kokoro-multi-lang-v1_1` 手动下载 `model.onnx`、`voices.bin`、`tokens.txt`、`lexicon-us-en.txt`、`lexicon-zh.txt`、`phone-zh.fst`、`date-zh.fst`、`number-zh.fst` 这 8 个文件放进一个文件夹，再点「指定本地模型文件夹…」。
5. 结果保存在「保存到」文件夹下带时间的子文件夹里，每次合成互不覆盖。文件名形如 `01-大家好欢迎来到今天的选品.mp3`，字幕同名 `.srt`（UTF-8 带 BOM）。

**工作方式**：每条文案先按句号、问号、感叹号、分号切句（单句过长再按逗号切），逐句合成后拼接，句与句之间插入静音；字幕时间轴用每一句的**实际合成时长**计算。一句话在字幕里显示成多行时，该句的时长按字数比例分摊（英文字母折算），是估算值。

**速度**：合成在 CPU 上单线程运行，实测（Chrome 的 WebAssembly）大约是音频时长的 1.3–1.5 倍，例如 11 秒的音频约需 13–15 秒。条数很多时请耐心等待，可随时取消，已生成的文件保留。

**商用提醒**：合成的配音用于商业发布时，请遵守所用模型的许可证（Kokoro 为 Apache-2.0）以及发布平台对 AI 合成内容的标识要求。国家网信办等四部门发布的《人工智能生成合成内容标识办法》自 2025 年 9 月 1 日起施行，把标识分为显式标识（用户能明显感知）和隐式标识（写在文件数据里）两类（见[中国网信网](https://www.cac.gov.cn/2025-03/14/c_1743654685899683.htm)），具体要求以法规原文和各平台规则为准；本工具不会给音频添加任何标识。

## 验收用例

以下用例在本机用 Chrome 里的 WebAssembly 引擎 + 内置 ffmpeg 跑通过（模型文件为上面 8 个文件）。

1. 打开应用，点「导入 txt / Excel…」选 `samples/示例文案.txt`。**应得到**：文案框 5 条，状态栏显示「5 条 · 5 句 · 150 字」，不含「示例」字样。
2. 改选 `samples/示例文案.xlsx`。**应得到**：自动读第 2 列「配音文案」并跳过表头，共 4 条；其中第 4 条中英混读。
3. 音色选「中文女声 01」，语速 1.00×，格式 MP3，勾选 SRT，输出方式「每条一个文件」，点「开始合成」。**应得到**：进度条显示「第 N / 5 条」；结果区列出 5 个 mp3；输出文件夹里每个 mp3 有同名 .srt。
4. 用 `ffprobe` 检查任一 mp3：编码 mp3、24000 Hz、单声道；时长与同名 SRT 最后一条的结束时间相差不超过 0.1 秒；播放有清晰人声。
5. 把输出方式改为「合成一个文件」、格式 WAV 再合成。**应得到**：只有 `合并配音.wav` 和 `合并配音.srt`；SRT 时间连续递增，条与条之间的间隔不小于所设「条间停顿」。
6. 断网后再合成一次（模型已下载）。**应得到**：照常合成。
7. 把文案框改成只有 `。。。` 一行再合成。**应得到**：该条显示失败，原因是没有可以朗读的文字。

## 自己编译

需要 Node.js 22、pnpm、Rust。

```bash
pnpm install
pnpm test          # 单元测试
pnpm tauri dev     # 开发运行
pnpm tauri build   # 打包
```

界面框架在 `src/kit`（所有 campfire-code 工具共用），本工具的逻辑在 `src/tool`。

## 致谢

本工具基于开源项目 [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)（Apache-2.0）的 WebAssembly 语音合成引擎，语音模型为 [Kokoro-82M-v1.1-zh](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh)（Apache-2.0）。

## 归属

本工具由**篝火**出品，是篝火 App 应用区收录的开源工具之一，由篝火（GitHub 组织 [campfire-code](https://github.com/campfire-code)）维护与更新。全部工具的目录见 [toolkit-hub](https://github.com/campfire-code/toolkit-hub)。

## 许可证

MIT，版权方为篝火（campfire-code）。
