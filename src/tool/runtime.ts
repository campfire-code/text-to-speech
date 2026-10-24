// 把合成模块接到 Tauri 的本机能力上：下载 / 缓存模型、加载引擎、写文件、调 ffmpeg。界面只调用这里。
import { appDataDir, join, tempDir } from '@tauri-apps/api/path';
import { exists, mkdir, readFile, remove, stat, writeFile } from '@tauri-apps/plugin-fs';
import { httpFetch } from '../kit/platform';
import type { RunContext } from '../kit/types';
import type { FlowDeps } from './flow';
import { loadEngine, type TtsEngine } from './tts/engine';
import { KOKORO, cacheDir, isCached, loadModelFiles, sha256Hex, sizeMB, type ModelDeps } from './tts/models';

type Ctx = Pick<RunContext, 'ffmpeg' | 'writeFile' | 'writeText' | 'join' | 'mkdir'>;

const modelDeps: ModelDeps = {
  fetch: (url, init) => httpFetch(url, { method: 'GET', signal: init.signal }) as unknown as ReturnType<ModelDeps['fetch']>,
  read: async (p) => ((await exists(p)) ? readFile(p) : null),
  size: async (p) => ((await exists(p)) ? (await stat(p)).size : null),
  write: async (p, d) => {
    await mkdir(p.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
    await writeFile(p, d);
  },
  join,
  sha256: sha256Hex,
};

export type Stage = { step: 'download' | 'load' | 'synth'; ratio: number; text: string };
export type ModelState = 'loaded' | 'cached' | 'missing';

let current: { key: string; engine: Promise<TtsEngine> } | null = null;

const root = async () => join(await appDataDir(), 'models');

/** 模型现在的状态：引擎已加载 / 文件已在缓存里 / 还没下载（指定了本地文件夹时视为已就绪） */
export async function modelState(localDir: string): Promise<ModelState> {
  if (current?.key === (localDir || 'cache')) return 'loaded';
  if (localDir) return 'cached';
  return (await isCached(modelDeps, KOKORO, await cacheDir(modelDeps, await root(), KOKORO))) ? 'cached' : 'missing';
}

/** 取得可用的引擎：本地文件夹 / 缓存 / 下载 → 校验 → 加载。同一份模型只加载一次 */
export async function prepareEngine(localDir: string, onStage: (s: Stage) => void, signal?: AbortSignal): Promise<TtsEngine> {
  const key = localDir || 'cache';
  if (current?.key === key) return current.engine;
  current?.engine.then((e) => e.dispose(), () => {});
  current = null;
  onStage({ step: 'download', ratio: 0, text: '正在检查语音模型…' });
  const files = await loadModelFiles(modelDeps, KOKORO, {
    cacheRoot: await root(),
    localDir: localDir || undefined,
    onDownload: (r) => onStage({ step: 'download', ratio: r, text: `首次使用，正在下载语音模型（约 ${sizeMB(KOKORO)} MB，只下载一次）…` }),
    signal,
  });
  onStage({ step: 'load', ratio: 0, text: '正在加载语音引擎…' });
  const engine = loadEngine(files);
  current = { key, engine };
  engine.catch(() => { if (current?.engine === engine) current = null; });
  return engine;
}

/** 流程需要的本机能力 */
export async function flowDeps(ctx: Ctx, engine: TtsEngine): Promise<FlowDeps> {
  const tmp = await tempDir();
  return {
    synth: engine.synth,
    join: (...p) => join(...p),
    mkdir: (p) => ctx.mkdir(p),
    writeFile: (p, d) => ctx.writeFile(p, d),
    writeText: (p, t) => ctx.writeText(p, t),
    ffmpeg: (args) => ctx.ffmpeg(args),
    tmpFile: (name) => join(tmp, name),
    remove: (p) => remove(p),
  };
}
