// 语音模型文件管理：Kokoro 多语种模型首次使用时下载到应用数据目录，逐个文件校验 SHA-256 后缓存。
// 网络、文件读写都通过参数传入，便于不联网测试。
//
// 模型：hexgrad/Kokoro-82M-v1.1-zh（Apache-2.0；中文数据由龙猫数据免费授权，见模型卡），
// 由 k2-fsa/sherpa-onnx 团队转成 ONNX，文件取自 Hugging Face 的 csukuangfj/kokoro-multi-lang-v1_1。
// 注意：同一作者的 int8 量化版（kokoro-int8-multi-lang-v1_1）在 WebAssembly 引擎里实测输出全是 NaN（无声），所以用完整精度版。
// 下载地址固定到某个提交；大小与 SHA-256 与 Hugging Face 页面上的 LFS 校验值一致（小文件为自行计算）。

export interface ModelFile {
  /** 相对模型目录的文件名 */
  name: string;
  size: number;
  sha256: string;
}

export interface ModelSpec {
  id: string;
  label: string;
  repo: string;
  commit: string;
  files: ModelFile[];
}

export const KOKORO: ModelSpec = {
  id: 'kokoro-zh-v1.1',
  label: '中英文多音色语音模型',
  repo: 'csukuangfj/kokoro-multi-lang-v1_1',
  commit: '914313412b607d95400bcd12446233fbd1248801',
  files: [
    { name: 'model.onnx', size: 325631784, sha256: 'acc4adc175b9d9986106cd20060329673ad5a2e12ef3c557d2d3745b694f8b38' },
    { name: 'voices.bin', size: 53790720, sha256: 'e64a5a581d8c2a350d848f51c3121657cd83aa07ed6109172177345874a7244c' },
    { name: 'tokens.txt', size: 1111, sha256: '931ab2df2400cd65d580a22402024c2347ced8ae9ea300e545144b1aacc48e14' },
    { name: 'lexicon-us-en.txt', size: 5956885, sha256: '7daaab53a181be9885b853a8582bf1838186317e5dadacbcef9c426d6fa0da14' },
    { name: 'lexicon-zh.txt', size: 2119465, sha256: '11111d8cd695fba2ace1367a1d0a708b586e6ef5c1f9be91da5d7eef129b651c' },
    { name: 'phone-zh.fst', size: 88630, sha256: '1ac2b6fa56b1442320c4de7db08353bab8963a2b57f365eebcdd3a2d3562f8d7' },
    { name: 'date-zh.fst', size: 59154, sha256: 'eb8aa079ae3cb81d8f4404992f39d61a0cb990947512b5b8d1e54d1f6980e718' },
    { name: 'number-zh.fst', size: 64482, sha256: '743f402181fcfebf76cc2f0546b71fa26476e626fbe4e460fb7b4c3a7a8bd5bd' },
  ],
};

export const MODELS: ModelSpec[] = [KOKORO];

export const modelTotalSize = (m: ModelSpec) => m.files.reduce((n, f) => n + f.size, 0);
export const fileUrl = (m: ModelSpec, f: ModelFile) => `https://huggingface.co/${m.repo}/resolve/${m.commit}/${f.name}`;
/** 界面上显示的体积，十进制 MB，取整 */
export const sizeMB = (m: ModelSpec) => Math.round(modelTotalSize(m) / 1e6);

export interface FetchedResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}

export interface ModelDeps {
  fetch(url: string, init: { signal?: AbortSignal }): Promise<FetchedResponse>;
  /** 读文件，不存在返回 null */
  read(path: string): Promise<Uint8Array | null>;
  /** 文件大小，不存在返回 null（只看大小，不读内容） */
  size(path: string): Promise<number | null>;
  write(path: string, data: Uint8Array): Promise<void>;
  join(...parts: string[]): string | Promise<string>;
  sha256(data: Uint8Array): Promise<string>;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 流式下载并回报已下载字节数；长度不对或连接中断都抛出带原因的错误 */
export async function downloadBytes(
  fetchFn: ModelDeps['fetch'], url: string, expectedSize: number, onBytes: (n: number) => void, signal?: AbortSignal,
): Promise<Uint8Array> {
  let res: FetchedResponse;
  try {
    res = await fetchFn(url, { signal });
  } catch (e) {
    if (signal?.aborted) throw new Error('已取消');
    throw new Error(`连不上模型下载地址（${e instanceof Error ? e.message : e}）。可以换个网络重试，或手动下载模型文件后点「指定本地模型文件夹」`);
  }
  if (!res.ok || !res.body) throw new Error(`模型下载失败（服务器返回 ${res.status}）`);
  const buf = new Uint8Array(expectedSize);
  let got = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (got + value.length > expectedSize) throw new Error('下载内容比预期的大，已中止');
      buf.set(value, got);
      got += value.length;
      onBytes(got);
    }
  } catch (e) {
    if (signal?.aborted) throw new Error('已取消');
    throw new Error(`下载中断：${e instanceof Error ? e.message : e}`);
  }
  if (got !== expectedSize) throw new Error(`下载不完整（收到 ${got} 字节，应为 ${expectedSize}）`);
  return buf;
}

export interface LoadOptions {
  /** 应用数据目录下存放模型的根目录，每个模型一个子文件夹 */
  cacheRoot: string;
  /** 手动指定的本地模型文件夹：里面要有和下载版同名的文件 */
  localDir?: string;
  /** 总进度 0–1，只在真正下载时回调 */
  onDownload?: (ratio: number) => void;
  signal?: AbortSignal;
}

/** 缓存里的文件是否齐全（只比对文件大小，不读内容），用于界面上显示「已下载」 */
export async function isCached(deps: ModelDeps, spec: ModelSpec, dir: string): Promise<boolean> {
  for (const f of spec.files) {
    if ((await deps.size(await deps.join(dir, f.name))) !== f.size) return false;
  }
  return true;
}

export const cacheDir = async (deps: ModelDeps, cacheRoot: string, spec: ModelSpec) => deps.join(cacheRoot, spec.id);

/**
 * 取得一个模型的全部文件（文件名 → 字节）：
 * 1. 指定了本地文件夹 → 逐个读取并校验，不联网；缺文件或校验不过就报出具体是哪个；
 * 2. 缓存里的文件校验通过 → 直接用；
 * 3. 否则逐个下载 → 校验 → 写入缓存。
 */
export async function loadModelFiles(deps: ModelDeps, spec: ModelSpec, opt: LoadOptions): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  const root = opt.localDir ?? (await cacheDir(deps, opt.cacheRoot, spec));
  const total = modelTotalSize(spec);
  let done = 0;
  for (const f of spec.files) {
    if (opt.signal?.aborted) throw new Error('已取消');
    const path = await deps.join(root, f.name);
    const have = await deps.read(path);
    if (have && have.length === f.size && (await deps.sha256(have)) === f.sha256) {
      out.set(f.name, have);
      done += f.size;
      continue;
    }
    if (opt.localDir) {
      if (!have) throw new Error(`指定的模型文件夹里缺少 ${f.name}（需要 ${spec.repo} 的同名文件）`);
      throw new Error(`指定的模型文件夹里的 ${f.name} 校验不通过，不是本工具需要的 ${spec.repo} 文件`);
    }
    const base = done;
    const data = await downloadBytes(deps.fetch, fileUrl(spec, f), f.size, (n) => opt.onDownload?.((base + n) / total), opt.signal);
    if ((await deps.sha256(data)) !== f.sha256) throw new Error(`${f.name} 下载后校验不通过（文件可能被篡改或下载出错），请重试`);
    await deps.write(path, data);
    out.set(f.name, data);
    done += f.size;
  }
  return out;
}

// ---------- 音色 ----------
// 模型里共 103 个音色，编号（sid）见 sherpa-onnx 文档 kokoro-multi-lang-v1_1：
// 0–2 英文女声（af_maple、af_sol、bf_vale），3–57 中文女声（55 个），58–102 中文男声（45 个）。

export interface VoiceGroup { id: 'zf' | 'zm' | 'en'; label: string; first: number; count: number }
export const VOICE_GROUPS: VoiceGroup[] = [
  { id: 'zf', label: '中文女声', first: 3, count: 55 },
  { id: 'zm', label: '中文男声', first: 58, count: 45 },
  { id: 'en', label: '英文女声', first: 0, count: 3 },
];
export const NUM_VOICES = 103;

export interface Voice { sid: number; label: string; group: VoiceGroup['id'] }

const EN_LABELS = ['英文女声（美）A', '英文女声（美）B', '英文女声（英）'];

export function voiceList(): Voice[] {
  return VOICE_GROUPS.flatMap((g) =>
    Array.from({ length: g.count }, (_, i): Voice => ({
      sid: g.first + i, group: g.id, label: g.id === 'en' ? EN_LABELS[i] : `${g.label} ${String(i + 1).padStart(2, '0')}`,
    })));
}
export const voiceBySid = (sid: number): Voice | undefined => voiceList().find((v) => v.sid === sid);
export const DEFAULT_SID = 3;
