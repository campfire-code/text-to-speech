// 预览与截图用的示例状态（自定义型工具把这些交给 Main 作为默认状态）。内容均为自编示例。
import type { OutputFile } from './flow';
import { SAMPLE_TEXT } from './samples';

export const demoText = SAMPLE_TEXT;
export const demoDir = '/Users/demo/Downloads/文案转配音/配音-20261023-101500';
export const demoFiles: OutputFile[] = [
  { name: '01-大家好欢迎来到今天的选.mp3', path: `${demoDir}/01-大家好欢迎来到今天的选.mp3`, srtPath: `${demoDir}/01-大家好欢迎来到今天的选.srt`, seconds: 4.3, entries: [0] },
  { name: '02-这款折叠收纳盒一共有三.mp3', path: `${demoDir}/02-这款折叠收纳盒一共有三.mp3`, srtPath: `${demoDir}/02-这款折叠收纳盒一共有三.srt`, seconds: 13.8, entries: [1] },
  { name: '03-新品上架第一天前一百位.mp3', path: `${demoDir}/03-新品上架第一天前一百位.mp3`, srtPath: `${demoDir}/03-新品上架第一天前一百位.srt`, seconds: 9.6, entries: [2] },
];
