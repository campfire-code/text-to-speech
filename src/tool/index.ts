// 工具声明：文案转配音（自定义界面；语音合成在本机离线完成，不调用大模型）。
import { AudioLines } from 'lucide-react';
import { createElement } from 'react';
import type { CustomTool } from '../kit/types';
import { Main } from './Main';

const tool: CustomTool = {
  id: 'c10',
  name: '文案转配音',
  tagline: '输入或批量导入文案（txt / Excel），选音色和语速，在本机离线合成配音，导出 WAV / MP3，并可同时导出与音频对齐的 SRT 字幕。不联网、不用显卡，仅首次使用需要下载语音模型。',
  icon: AudioLines,
  category: '内容生产',
  type: 'media',
  mode: 'custom',
  mainLabel: '文案转配音',
  params: [],
  Main: ({ ctx }) => createElement(Main, { ctx }),
};

export default tool;
