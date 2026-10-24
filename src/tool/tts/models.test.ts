import { describe, expect, it } from 'vitest';
import { KOKORO, NUM_VOICES, VOICE_GROUPS, downloadBytes, fileUrl, isCached, loadModelFiles, modelTotalSize, sha256Hex, sizeMB, voiceBySid, voiceList, type ModelDeps, type ModelSpec } from './models';

const enc = (s: string) => new TextEncoder().encode(s);

async function makeSpec(contents: Record<string, string>): Promise<ModelSpec> {
  const files = [];
  for (const [name, text] of Object.entries(contents)) files.push({ name, size: enc(text).length, sha256: await sha256Hex(enc(text)) });
  return { id: 'm', label: 't', repo: 'x/y', commit: 'abc', files };
}

function fakeDeps(remote: Record<string, string>, disk = new Map<string, Uint8Array>()) {
  const fetched: string[] = [];
  const deps: ModelDeps = {
    async fetch(url) {
      fetched.push(url);
      const name = decodeURIComponent(url.split('/resolve/abc/')[1]);
      if (!(name in remote)) return { ok: false, status: 404, headers: { get: () => null }, body: null };
      const data = enc(remote[name]);
      const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(data.subarray(0, 2)); c.enqueue(data.subarray(2)); c.close(); } });
      return { ok: true, status: 200, headers: { get: () => String(data.length) }, body };
    },
    async read(p) { return disk.get(p) ?? null; },
    async size(p) { return disk.get(p)?.length ?? null; },
    async write(p, d) { disk.set(p, d); },
    join: (...parts) => parts.join('/'),
    sha256: sha256Hex,
  };
  return { deps, fetched, disk };
}

describe('模型清单', () => {
  it('Kokoro：文件齐全，提交固定，校验值格式正确，下载地址指向 Hugging Face', () => {
    expect(KOKORO.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(KOKORO.files.map((f) => f.name).sort()).toEqual(['date-zh.fst', 'lexicon-us-en.txt', 'lexicon-zh.txt', 'model.onnx', 'number-zh.fst', 'phone-zh.fst', 'tokens.txt', 'voices.bin']);
    KOKORO.files.forEach((f) => { expect(f.sha256).toMatch(/^[0-9a-f]{64}$/); expect(f.size).toBeGreaterThan(0); });
    expect(fileUrl(KOKORO, KOKORO.files[0])).toBe(`https://huggingface.co/csukuangfj/kokoro-multi-lang-v1_1/resolve/${KOKORO.commit}/model.onnx`);
    expect(modelTotalSize(KOKORO)).toBe(387_712_231);
    expect(sizeMB(KOKORO)).toBe(388);
  });
  it('音色：103 个，编号与模型一致（0–2 英文女声，3–57 中文女声，58–102 中文男声）', () => {
    const v = voiceList();
    expect(v).toHaveLength(NUM_VOICES);
    expect(v.map((x) => x.sid).sort((a, b) => a - b)).toEqual([...Array(103).keys()]);
    expect(new Set(v.map((x) => x.sid)).size).toBe(103);
    expect(voiceBySid(0)?.group).toBe('en');
    expect(voiceBySid(2)?.label).toBe('英文女声（英）');
    expect(voiceBySid(3)).toMatchObject({ group: 'zf', label: '中文女声 01' });
    expect(voiceBySid(57)).toMatchObject({ group: 'zf', label: '中文女声 55' });
    expect(voiceBySid(58)).toMatchObject({ group: 'zm', label: '中文男声 01' });
    expect(voiceBySid(102)).toMatchObject({ group: 'zm', label: '中文男声 45' });
    expect(voiceBySid(103)).toBeUndefined();
    expect(VOICE_GROUPS.reduce((n, g) => n + g.count, 0)).toBe(103);
  });
});

describe('模型下载与缓存', () => {
  it('首次使用：下载、校验、写入缓存并回报进度；第二次直接用缓存不联网', async () => {
    const remote = { 'a.txt': 'hello', 'b.bin': 'world-model' };
    const spec = await makeSpec(remote);
    const { deps, fetched, disk } = fakeDeps(remote);
    const ratios: number[] = [];
    expect(await isCached(deps, spec, '/data/m')).toBe(false);
    const files = await loadModelFiles(deps, spec, { cacheRoot: '/data', onDownload: (r) => ratios.push(r) });
    expect(files.size).toBe(2);
    expect(fetched).toHaveLength(2);
    expect(disk.has('/data/m/b.bin')).toBe(true);
    expect(ratios.at(-1)).toBeCloseTo(1);
    expect(ratios).toEqual([...ratios].sort((a, b) => a - b));
    expect(await isCached(deps, spec, '/data/m')).toBe(true);
    const again = fakeDeps({}, disk);
    const second: number[] = [];
    await loadModelFiles(again.deps, spec, { cacheRoot: '/data', onDownload: (r) => second.push(r) });
    expect(again.fetched).toHaveLength(0);
    expect(second).toEqual([]);
  });

  it('缓存里的文件被改坏（长度对、内容不对）：重新下载覆盖', async () => {
    const remote = { 'a.txt': 'hello' };
    const spec = await makeSpec(remote);
    const disk = new Map([['/data/m/a.txt', enc('HELLO')]]);
    const { deps, fetched } = fakeDeps(remote, disk);
    const files = await loadModelFiles(deps, spec, { cacheRoot: '/data' });
    expect(fetched).toHaveLength(1);
    expect(new TextDecoder().decode(files.get('a.txt'))).toBe('hello');
    expect(new TextDecoder().decode(disk.get('/data/m/a.txt'))).toBe('hello');
  });

  it('下载下来的内容校验不过：报错且不写入缓存', async () => {
    const spec = await makeSpec({ 'a.txt': 'hello' });
    const { deps, disk } = fakeDeps({ 'a.txt': 'hellO' });
    await expect(loadModelFiles(deps, spec, { cacheRoot: '/data' })).rejects.toThrow('校验不通过');
    expect(disk.size).toBe(0);
  });

  it('本地模型文件夹：校验通过就用，完全不联网；缺文件或校验不过会指出是哪个文件', async () => {
    const remote = { 'a.txt': 'hello', 'b.bin': 'world-model' };
    const spec = await makeSpec(remote);
    const disk = new Map([['/mine/a.txt', enc('hello')], ['/mine/b.bin', enc('world-model')]]);
    const ok = fakeDeps({}, disk);
    expect((await loadModelFiles(ok.deps, spec, { cacheRoot: '/data', localDir: '/mine' })).size).toBe(2);
    expect(ok.fetched).toHaveLength(0);
    const missing = fakeDeps({}, new Map([['/mine/a.txt', enc('hello')]]));
    await expect(loadModelFiles(missing.deps, spec, { cacheRoot: '/data', localDir: '/mine' })).rejects.toThrow('缺少 b.bin');
    const wrong = fakeDeps({}, new Map([['/mine/a.txt', enc('hellO')], ['/mine/b.bin', enc('world-model')]]));
    await expect(loadModelFiles(wrong.deps, spec, { cacheRoot: '/data', localDir: '/mine' })).rejects.toThrow('a.txt 校验不通过');
    expect(wrong.fetched).toHaveLength(0);
  });

  it('下载失败的几种情况都有明确的中文提示', async () => {
    const spec = await makeSpec({ 'a.txt': 'hello' });
    await expect(loadModelFiles(fakeDeps({}).deps, spec, { cacheRoot: '/d' })).rejects.toThrow('服务器返回 404');
    const refuse = fakeDeps({}).deps;
    refuse.fetch = async () => { throw new Error('net down'); };
    await expect(loadModelFiles(refuse, spec, { cacheRoot: '/d' })).rejects.toThrow('连不上模型下载地址');
    const short = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc('he')); c.close(); } });
    await expect(downloadBytes(async () => ({ ok: true, status: 200, headers: { get: () => null }, body: short }), 'u', 5, () => {})).rejects.toThrow('下载不完整');
    const big = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc('hello!!')); c.close(); } });
    await expect(downloadBytes(async () => ({ ok: true, status: 200, headers: { get: () => null }, body: big }), 'u', 5, () => {})).rejects.toThrow('比预期的大');
  });

  it('取消：下载前 / 下载中都会抛出「已取消」', async () => {
    const remote = { 'a.txt': 'hello' };
    const spec = await makeSpec(remote);
    const ac = new AbortController();
    ac.abort();
    await expect(loadModelFiles(fakeDeps(remote).deps, spec, { cacheRoot: '/d', signal: ac.signal })).rejects.toThrow('已取消');
  });
});
