import { describe, expect, it } from 'vitest';
import { BOM, countSentences, runJob, type FlowDeps, type JobOptions } from './flow';
import type { Synth } from './tts/engine';

const SR = 24000;
/** 假合成：每个字 0.1 秒，内容是常数，便于核对拼接结果 */
const fakeSynth = (log: string[] = []): Synth => async (text, sid, speed) => {
  log.push(`${sid}|${speed}|${text}`);
  return { samples: new Float32Array([...text.replace(/[\s\p{P}]/gu, '')].length * 2400).fill(0.25), sampleRate: SR };
};

function fakeDeps(synth: Synth = fakeSynth()) {
  const files = new Map<string, Uint8Array>();
  const texts = new Map<string, string>();
  const ffmpegCalls: string[][] = [];
  const removed: string[] = [];
  const dirs = new Set<string>();
  const deps: FlowDeps = {
    synth,
    join: (...p) => p.join('/'),
    async mkdir(p) { dirs.add(p); },
    async writeFile(p, d) { files.set(p, d); },
    async writeText(p, t) { texts.set(p, t); },
    async ffmpeg(args) {
      ffmpegCalls.push(args);
      // 模拟转码：输入文件必须已存在，输出写一个占位文件
      const input = args[args.indexOf('-i') + 1];
      if (!files.has(input)) throw new Error('输入不存在');
      // 真实的 ffmpeg 不会替我们建输出文件夹
      if (!dirs.has(args.at(-1)!.replace(/\/[^/]+$/, ''))) throw new Error('输出文件夹不存在');
      files.set(args.at(-1)!, new Uint8Array([1, 2, 3]));
    },
    async tmpFile(name) { return `/tmp/${name}`; },
    async remove(p) { removed.push(p); files.delete(p); },
  };
  return { deps, files, texts, ffmpegCalls, removed, dirs };
}

const opts = (o: Partial<JobOptions> = {}): JobOptions => ({
  entries: ['你好，世界。今天很好！', 'Hello there.'], sid: 3, speed: 1, format: 'wav', srt: true, mode: 'each', sentenceGap: 0.5, entryGap: 1, maxLine: 24, outDir: '/out', ...o,
});

const wavSeconds = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset).getUint32(40, true) / 2 / SR;

describe('runJob 每条一个文件', () => {
  it('逐句合成（带音色和语速），写出 WAV 和同名 SRT，时间轴用实际时长', async () => {
    const log: string[] = [];
    const { deps, files, texts } = fakeDeps(fakeSynth(log));
    const progress: number[] = [];
    const r = await runJob(opts({ speed: 1.2 }), deps, (p) => progress.push(p.ratio));
    expect(log).toEqual(['3|1.2|你好，世界。', '3|1.2|今天很好！', '3|1.2|Hello there.']);
    expect(r.failed).toEqual([]);
    expect(r.files.map((f) => f.name)).toEqual(['01-你好世界今天很好.wav', '02-Hellothere.wav']);
    // 第一条：「你好，世界。」4 字 0.4s；停 0.5s；「今天很好！」4 字 0.4s → 共 1.3 秒
    expect(r.files[0].seconds).toBeCloseTo(1.3, 6);
    expect(wavSeconds(files.get('/out/01-你好世界今天很好.wav')!)).toBeCloseTo(1.3, 3);
    expect(r.files[1].seconds).toBeCloseTo(1.0, 6); // 10 个字母
    const srt = texts.get('/out/01-你好世界今天很好.srt')!;
    expect(srt.startsWith(BOM)).toBe(true);
    expect(srt.slice(1)).toBe('1\n00:00:00,000 --> 00:00:00,400\n你好，世界\n\n2\n00:00:00,900 --> 00:00:01,300\n今天很好！\n');
    expect(r.files[0].srtPath).toBe('/out/01-你好世界今天很好.srt');
    // 进度单调不减，最后到 1
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress.at(-1)).toBe(1);
  });

  it('不勾选字幕时不写 SRT', async () => {
    const { deps, texts } = fakeDeps();
    const r = await runJob(opts({ srt: false }), deps, () => {});
    expect(texts.size).toBe(0);
    expect(r.files[0].srtPath).toBeUndefined();
  });

  it('MP3：先写临时 WAV，调用 ffmpeg 转码，转完删除临时文件', async () => {
    const { deps, files, ffmpegCalls, removed } = fakeDeps();
    const r = await runJob(opts({ format: 'mp3' }), deps, () => {});
    expect(r.files.map((f) => f.name)).toEqual(['01-你好世界今天很好.mp3', '02-Hellothere.mp3']);
    expect(ffmpegCalls).toHaveLength(2);
    const [args] = ffmpegCalls;
    expect(args[0]).toBe('-i');
    expect(args[1]).toMatch(/^\/tmp\/c10-.*\.wav$/);
    expect(args.slice(2, -1)).toEqual(['-vn', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '192k']);
    expect(args.at(-1)).toBe('/out/01-你好世界今天很好.mp3');
    expect(removed).toHaveLength(2);
    expect([...files.keys()].filter((k) => k.startsWith('/tmp/'))).toEqual([]);
    expect(files.has('/out/01-你好世界今天很好.mp3')).toBe(true);
  });

  it('ffmpeg 失败也会清理临时文件，并让整个任务报错', async () => {
    const { deps, removed } = fakeDeps();
    deps.ffmpeg = async () => { throw new Error('ffmpeg 处理失败'); };
    await expect(runJob(opts({ format: 'mp3' }), deps, () => {})).rejects.toThrow('ffmpeg 处理失败');
    expect(removed).toHaveLength(1);
  });

  it('某句合成失败只影响这一条，其余照常输出；失败原因记录在 failed 里', async () => {
    const base = fakeSynth();
    const { deps } = fakeDeps(async (t, s, sp) => { if (t.includes('世界')) throw new Error('这句话没有合成出声音'); return base(t, s, sp); });
    const r = await runJob(opts(), deps, () => {});
    expect(r.files.map((f) => f.name)).toEqual(['02-Hellothere.wav']);
    expect(r.failed).toEqual([{ index: 0, text: '你好，世界。今天很好！', error: '这句话没有合成出声音' }]);
  });

  it('只有标点的条目记为失败，不调用合成', async () => {
    const log: string[] = [];
    const { deps } = fakeDeps(fakeSynth(log));
    const r = await runJob(opts({ entries: ['。。。', '好的。'] }), deps, () => {});
    expect(log).toEqual(['3|1|好的。']);
    expect(r.failed[0].index).toBe(0);
    expect(r.failed[0].error).toContain('没有可以朗读的文字');
    expect(r.files.map((f) => f.name)).toEqual(['02-好的.wav']);
  });

  it('取消：抛出「已取消」，已经写出的文件保留', async () => {
    const ac = new AbortController();
    const base = fakeSynth();
    const { deps, files } = fakeDeps(async (t, s, sp) => { const a = await base(t, s, sp); if (t.startsWith('今天')) ac.abort(); return a; });
    await expect(runJob(opts(), deps, () => {}, ac.signal)).rejects.toThrow('已取消');
    expect(files.has('/out/01-你好世界今天很好.wav')).toBe(true);
    expect(files.has('/out/02-Hellothere.wav')).toBe(false);
  });
});

describe('runJob 合成一个文件', () => {
  it('所有条目拼成一个音频，条间停顿，SRT 时间轴连续', async () => {
    const { deps, files, texts } = fakeDeps();
    const r = await runJob(opts({ mode: 'merge', entries: ['你好呀。', '再见啦。'], sentenceGap: 0.5, entryGap: 1 }), deps, () => {});
    expect(r.files).toHaveLength(1);
    expect(r.files[0].name).toBe('合并配音.wav');
    expect(r.files[0].entries).toEqual([0, 1]);
    // 0.3 + 1.0 + 0.3 = 1.6 秒
    expect(r.files[0].seconds).toBeCloseTo(1.6, 6);
    expect(wavSeconds(files.get('/out/合并配音.wav')!)).toBeCloseTo(1.6, 3);
    expect(texts.get('/out/合并配音.srt')!.slice(1)).toBe('1\n00:00:00,000 --> 00:00:00,300\n你好呀\n\n2\n00:00:01,300 --> 00:00:01,600\n再见啦\n');
  });

  it('失败的条目被跳过，其余照常合并', async () => {
    const { deps } = fakeDeps();
    const r = await runJob(opts({ mode: 'merge', entries: ['？？', '再见啦。'] }), deps, () => {});
    expect(r.files[0].entries).toEqual([1]);
    expect(r.failed.map((f) => f.index)).toEqual([0]);
  });

  it('全部失败时不写文件', async () => {
    const { deps, files } = fakeDeps();
    const r = await runJob(opts({ mode: 'merge', entries: ['？？'] }), deps, () => {});
    expect(r.files).toEqual([]);
    expect(files.size).toBe(0);
  });
});

describe('countSentences', () => {
  it('统计总句数', () => expect(countSentences(['一。二。', '三'])).toBe(3));
});
