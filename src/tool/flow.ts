// 合成流程：文案 → 分句 → 逐句合成 → 拼接 → 写出 WAV / MP3（可选 SRT）。
// 合成、写文件、ffmpeg 都通过参数传入，测试时用假函数。
import { composeTrack, encodeWav, entryFileName, mp3Args, splitSentences, toSrt, type Part, type Track } from './core';
import type { Synth } from './tts/engine';

export interface JobOptions {
  entries: string[];
  sid: number;
  speed: number;
  format: 'wav' | 'mp3';
  /** 同时写出与音频对齐的 SRT */
  srt: boolean;
  /** each：每条文案一个文件；merge：全部拼成一个文件 */
  mode: 'each' | 'merge';
  /** 句与句之间的停顿（秒） */
  sentenceGap: number;
  /** 条与条之间的停顿（秒，只在合并成一个文件时用） */
  entryGap: number;
  /** 字幕每行最多的字符数 */
  maxLine: number;
  /** 输出文件夹（已经是本次专用的子文件夹） */
  outDir: string;
}

export interface FlowDeps {
  synth: Synth;
  join(...parts: string[]): Promise<string> | string;
  /** 建输出文件夹（含上级）。ffmpeg 不会自己建文件夹，所以必须先建 */
  mkdir(path: string): Promise<void>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  writeText(path: string, text: string): Promise<void>;
  ffmpeg(args: string[]): Promise<void>;
  /** 临时文件路径（MP3 转码时先写一份 WAV） */
  tmpFile(name: string): Promise<string>;
  remove(path: string): Promise<void>;
}

export interface Progress {
  /** 正在处理第几条（从 1 开始）/ 共几条 */
  entry: number;
  entries: number;
  /** 已合成的句数 / 总句数 */
  doneSentences: number;
  totalSentences: number;
  ratio: number;
}

export interface OutputFile {
  name: string;
  path: string;
  srtPath?: string;
  seconds: number;
  /** 包含的文案序号（从 0 开始） */
  entries: number[];
}
export interface Failure { index: number; text: string; error: string }
export interface JobResult { files: OutputFile[]; failed: Failure[] }

export const BOM = '﻿';

/** 文案总句数（用于界面上估计工作量） */
export const countSentences = (entries: string[]) => entries.reduce((n, e) => n + splitSentences(e).length, 0);

async function writeAudio(track: Track, base: string, o: JobOptions, d: FlowDeps): Promise<{ path: string; srtPath?: string }> {
  const wav = encodeWav(track.samples, track.sampleRate);
  const path = await d.join(o.outDir, `${base}.${o.format}`);
  if (o.format === 'wav') await d.writeFile(path, wav);
  else {
    const tmp = await d.tmpFile(`c10-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
    try {
      await d.writeFile(tmp, wav);
      await d.ffmpeg(mp3Args(tmp, path));
    } finally {
      await d.remove(tmp).catch(() => {});
    }
  }
  if (!o.srt) return { path };
  const srtPath = await d.join(o.outDir, `${base}.srt`);
  await d.writeText(srtPath, BOM + toSrt(track.cues));
  return { path, srtPath };
}

export async function runJob(o: JobOptions, d: FlowDeps, onProgress: (p: Progress) => void, signal?: AbortSignal): Promise<JobResult> {
  await d.mkdir(o.outDir);
  const plans = o.entries.map((t) => splitSentences(t));
  const totalSentences = plans.reduce((n, p) => n + p.length, 0);
  const files: OutputFile[] = [];
  const failed: Failure[] = [];
  const kept: { index: number; parts: Part[] }[] = [];
  let sampleRate = 24000;
  let done = 0;
  const report = (entry: number) => onProgress({ entry: entry + 1, entries: o.entries.length, doneSentences: done, totalSentences, ratio: totalSentences ? done / totalSentences : 1 });

  for (let i = 0; i < o.entries.length; i++) {
    if (signal?.aborted) throw new Error('已取消');
    const sentences = plans[i];
    report(i);
    if (!sentences.length) {
      failed.push({ index: i, text: o.entries[i], error: '这条文案里没有可以朗读的文字（只有标点或符号）' });
      continue;
    }
    const parts: Part[] = [];
    try {
      for (const s of sentences) {
        if (signal?.aborted) throw new Error('已取消');
        const a = await d.synth(s, o.sid, o.speed);
        sampleRate = a.sampleRate;
        parts.push({ text: s, samples: a.samples });
        done++;
        report(i);
      }
    } catch (e) {
      if (signal?.aborted) throw new Error('已取消');
      done += sentences.length - parts.length;
      failed.push({ index: i, text: o.entries[i], error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (o.mode === 'each') {
      const track = composeTrack([parts], sampleRate, o.sentenceGap, 0, o.maxLine);
      const base = entryFileName(i, o.entries.length, o.entries[i], o.format).replace(/\.[^.]+$/, '');
      const w = await writeAudio(track, base, o, d);
      files.push({ name: `${base}.${o.format}`, ...w, seconds: track.samples.length / sampleRate, entries: [i] });
    } else kept.push({ index: i, parts });
  }

  if (o.mode === 'merge' && kept.length) {
    const track = composeTrack(kept.map((k) => k.parts), sampleRate, o.sentenceGap, o.entryGap, o.maxLine);
    const w = await writeAudio(track, '合并配音', o, d);
    files.push({ name: `合并配音.${o.format}`, ...w, seconds: track.samples.length / sampleRate, entries: kept.map((k) => k.index) });
  }
  onProgress({ entry: o.entries.length, entries: o.entries.length, doneSentences: totalSentences, totalSentences, ratio: 1 });
  return { files, failed };
}
