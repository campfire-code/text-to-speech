// 纯函数：文案拆条、分句、字幕时间轴、WAV 编码、SRT、文件命名、ffmpeg 参数。
// 不依赖界面、模型和本机能力，便于单元测试。

// ---------- 文案拆条 ----------

/** 去掉零宽字符与 BOM，统一换行 */
export function cleanText(s: string): string {
  return s.replace(/[​-‍⁠﻿]/g, '').replace(/\r\n?/g, '\n');
}

/** 文本框 / txt：每个非空行是一条文案 */
export function parseEntries(text: string): string[] {
  return cleanText(text).split('\n').map((l) => l.trim()).filter(Boolean);
}

// ---------- 分句 ----------

const STRONG = new Set(['。', '！', '？', '!', '?', '；', ';']);
const CLOSERS = new Set(['”', '’', '"', "'", '」', '』', '）', ')', '】', '》']);
const WEAK = new Set(['，', ',', '、', '：', ':']);
const PUNCT_RE = /^[\s\p{P}\p{S}]+$/u;

/** 内容里有没有可读的字（只有标点 / 符号的片段合成不出声音） */
export const hasSpeakable = (s: string) => !PUNCT_RE.test(s);

/**
 * 按句切分，一句对应一次合成。
 * 句末符号：。！？!?；; 以及后面跟空白或结尾的英文句号（99.5、Type-C 这类不会被切开）；省略号 …… 也算句末。
 * 单句超过 maxUnit 个字符时，再按逗号、顿号、冒号切；仍然超长就硬切。只有标点的片段并入上一句。
 */
export function splitSentences(text: string, maxUnit = 80): string[] {
  const t = cleanText(text).replace(/\n+/g, '。');
  const raw: string[] = [];
  let cur = '';
  const chars = [...t];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    cur += c;
    const next = chars[i + 1];
    let cut = STRONG.has(c);
    if (c === '…') cut = next !== '…';
    if (c === '.') cut = next === undefined || /\s/.test(next);
    if (cut) {
      while (CLOSERS.has(chars[i + 1])) cur += chars[++i];
      raw.push(cur);
      cur = '';
    }
  }
  if (cur.trim()) raw.push(cur);

  const merged: string[] = [];
  for (const r of raw.map((x) => x.trim()).filter(Boolean)) {
    if (!hasSpeakable(r) && merged.length) merged[merged.length - 1] += r;
    else merged.push(r);
  }
  return merged.filter(hasSpeakable).flatMap((u) => breakLong(u, maxUnit));
}

/** 把超长的一句拆成不超过 limit 的几段：优先在弱标点后断开，其次英文空格，最后硬切 */
function breakLong(s: string, limit: number): string[] {
  if ([...s].length <= limit) return [s];
  const out: string[] = [];
  let cur = '';
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
  for (const clause of clauses(s)) {
    if ([...cur + clause].length > limit) push();
    if ([...clause].length > limit) {
      for (const piece of hardSplit(clause, limit)) { cur = piece; push(); }
    } else cur += clause;
  }
  push();
  return out.filter(hasSpeakable);
}

/** 在弱标点（含句末符号）之后切成小句，标点留在前一小句末尾 */
function clauses(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const c of s) {
    cur += c;
    if (WEAK.has(c) || STRONG.has(c)) { out.push(cur); cur = ''; }
  }
  if (cur) out.push(cur);
  return out;
}

/** 硬切成不超过 limit 的几段（默认每个字符算 1，字幕行用 charWidth）；英文尽量在空格处断开 */
function hardSplit(s: string, limit: number, measure: (c: string) => number = () => 1): string[] {
  const out: string[] = [];
  let rest = [...s];
  while (rest.reduce((n, c) => n + measure(c), 0) > limit) {
    let cut = 0;
    let w = 0;
    while (cut < rest.length && w + measure(rest[cut]) <= limit) w += measure(rest[cut++]);
    cut = Math.max(1, cut);
    const sp = rest.slice(0, cut).lastIndexOf(' ');
    if (rest[cut] !== ' ' && sp > cut * 0.4) cut = sp + 1; // 刚好在词尾就不用回退
    out.push(rest.slice(0, cut).join(''));
    rest = rest.slice(cut);
  }
  if (rest.length) out.push(rest.join(''));
  return out;
}

/** 单个字符的显示宽度：汉字、全角符号算 1，英文字母数字、半角符号算 0.5 */
const charWidth = (c: string) => (/[\u2e80-\u9fff\uff00-\uffef\u3000-\u303f\u2018-\u201f\u2026]/.test(c) ? 1 : 0.5);
export const width = (s: string) => [...s].reduce((n, c) => n + charWidth(c), 0);

// ---------- 字幕行 ----------

/** 字幕里不留行末的逗号句号，保留问号叹号 */
export const cleanCue = (s: string) => s.replace(/[\s，,、。；;：:.]+$/u, '').replace(/^[\s，,、。；;]+/u, '').trim();

/** 一句话在字幕里显示成几行：按小句打包，每行不超过 maxLine 个字符 */
export function splitCue(text: string, maxLine: number): string[] {
  const lines: string[] = [];
  let cur = '';
  const len = (x: string) => width(x.replace(/\s+/g, ' ').trim());
  for (const clause of clauses(text)) {
    for (const piece of len(clause) > maxLine ? hardSplit(clause, maxLine, charWidth) : [clause]) {
      if (cur && len(cur + piece) > maxLine) { lines.push(cur); cur = ''; }
      cur += piece;
    }
  }
  if (cur) lines.push(cur);
  return lines.map(cleanCue).filter((l) => l && hasSpeakable(l));
}

/** 一句话拆成多行字幕时，按「说出来大概多久」分摊时长：汉字、数字各算 1，英文字母算 0.3，不计空白与标点，至少为 1 */
export const weight = (s: string) => Math.max(1, [...s].reduce((n, c) => (/[\s\p{P}\p{S}]/u.test(c) ? n : /[A-Za-z]/.test(c) ? n + 0.3 : n + 1), 0));

// ---------- 时间轴 ----------

export interface Cue { start: number; end: number; text: string }
export interface Part { text: string; samples: Float32Array }
export interface Track {
  samples: Float32Array;
  sampleRate: number;
  cues: Cue[];
  /** 每条文案在整条音频里的起止秒 */
  ranges: { start: number; end: number }[];
}

/**
 * 把「若干条文案 × 若干句」的合成结果拼成一条音轨，并用每一句的实际采样数算时间轴。
 * 句与句之间停 sentenceGap 秒，条与条之间停 entryGap 秒（最后一句后面不加）。
 * 一句话拆成多行字幕时，按字数比例（英文字母折算）分摊这一句的实际时长。
 */
export function composeTrack(entries: Part[][], sampleRate: number, sentenceGap: number, entryGap: number, maxLine: number): Track {
  const sentGap = Math.round(sentenceGap * sampleRate);
  const entGap = Math.round(entryGap * sampleRate);
  const chunks: Float32Array[] = [];
  const cues: Cue[] = [];
  const ranges: Track['ranges'] = [];
  let pos = 0; // 已写入的采样数
  const put = (a: Float32Array) => { chunks.push(a); pos += a.length; };
  const silence = (n: number) => { if (n > 0) put(new Float32Array(n)); };
  let first = true;
  for (const parts of entries) {
    if (!parts.length) continue;
    if (!first) silence(entGap);
    first = false;
    const entryStart = pos;
    parts.forEach((p, i) => {
      if (i > 0) silence(sentGap);
      const start = pos / sampleRate;
      put(p.samples);
      const end = pos / sampleRate;
      const lines = splitCue(p.text, maxLine);
      const total = lines.reduce((n, l) => n + weight(l), 0) || 1;
      let t = start;
      lines.forEach((l, k) => {
        const e = k === lines.length - 1 ? end : t + ((end - start) * weight(l)) / total;
        cues.push({ start: t, end: e, text: l });
        t = e;
      });
    });
    ranges.push({ start: entryStart / sampleRate, end: pos / sampleRate });
  }
  const samples = new Float32Array(pos);
  let off = 0;
  for (const c of chunks) { samples.set(c, off); off += c.length; }
  return { samples, sampleRate, cues, ranges };
}

/** 秒 → 00:01:02,345 */
export function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor((ms % 3600000) / 60000))}:${p(Math.floor((ms % 60000) / 1000))},${p(ms % 1000, 3)}`;
}

export function toSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n');
}

// ---------- WAV ----------

/** 16 位 PCM 单声道 WAV */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, Math.round(x < 0 ? x * 0x8000 : x * 0x7fff), true);
  }
  return new Uint8Array(buf);
}

// ---------- 文件命名 ----------

const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;

/** 取文案开头几个字做文件名的一部分；去掉非法字符与标点，空了就返回空串 */
export function snippet(text: string, max = 12): string {
  const s = [...text.replace(ILLEGAL, '').replace(/[\s\p{P}\p{S}]+/gu, '')].slice(0, max).join('');
  return s;
}

/** 001-大家好欢迎来到.wav：序号补零到总数的位数（至少 2 位） */
export function entryFileName(index: number, total: number, text: string, ext: string): string {
  const width = Math.max(2, String(total).length);
  const sn = snippet(text);
  return `${String(index + 1).padStart(width, '0')}${sn ? '-' + sn : ''}.${ext}`;
}

/** 每次合成放进一个以时间命名的子文件夹，不会覆盖上次的结果 */
export function runFolderName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `配音-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---------- ffmpeg ----------

export const MP3_KBPS = 192;

/** WAV 转 MP3 的 ffmpeg 参数（单声道，保持模型的 24 kHz 采样率） */
export function mp3Args(input: string, output: string, kbps = MP3_KBPS): string[] {
  return ['-i', input, '-vn', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', `${kbps}k`, output];
}

// ---------- 其他 ----------

export const fmtDuration = (sec: number) => {
  const s = Math.round(sec);
  return s >= 60 ? `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒` : `${sec < 10 ? sec.toFixed(1) : s} 秒`;
};
