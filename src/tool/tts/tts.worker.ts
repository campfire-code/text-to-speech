// 合成线程：在 Web Worker 里运行 sherpa-onnx（Apache-2.0）的 WebAssembly 版，加载 Kokoro 模型并逐句合成。
// 放在线程里是为了合成时界面不卡。模型文件由主线程取得并校验后传入，这里不访问网络。
// 引擎文件取自 sherpa-onnx v2.0.0 发行包里的浏览器版 WebAssembly 构建，见 vendor/README.md。
import glueSrc from './vendor/sherpa-onnx-wasm-main-tts.js?raw';
import ttsSrc from './vendor/sherpa-onnx-tts.js?raw';
import wasmUrl from './vendor/sherpa-onnx-wasm-main-tts.wasm?url';

export type ToWorker =
  | { type: 'init'; files: [string, Uint8Array][] }
  | { type: 'synth'; id: number; text: string; sid: number; speed: number };
export type FromWorker =
  | { type: 'ready'; sampleRate: number; numSpeakers: number }
  | { type: 'initError'; message: string }
  | { type: 'audio'; id: number; samples: Float32Array; sampleRate: number }
  | { type: 'fail'; id: number; message: string };

/* eslint-disable @typescript-eslint/no-explicit-any */
type Tts = { sampleRate: number; numSpeakers: number; generate(c: { text: string; sid: number; speed: number }): { samples: Float32Array; sampleRate: number } };
let tts: Tts | null = null;
const post = (m: FromWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

/** 发行包里的 sherpa-onnx-tts.js 是 CommonJS 写法，包一层函数执行并取出导出 */
function loadTtsApi(): any {
  const mod: { exports: any } = { exports: {} };
  new Function('module', 'exports', 'process', `${ttsSrc}\n//# sourceURL=sherpa-onnx-tts.js`)(mod, mod.exports, { versions: { node: '22.0.0' } });
  return mod.exports;
}

/** 执行 WebAssembly 胶水脚本。它自带一个打包好的示例模型数据包，这里把数据包替换成空的，模型改由我们写入内存文件系统 */
function loadWasm(): Promise<any> {
  return new Promise((resolve, reject) => {
    const M: any = {
      locateFile: (path: string) => (path.endsWith('.wasm') ? wasmUrl : path),
      getPreloadedPackage: () => new ArrayBuffer(0),
      setStatus: () => {},
      print: () => {},
      printErr: () => {},
      onAbort: (what: unknown) => reject(new Error(`引擎中止：${what}`)),
      onRuntimeInitialized: () => resolve(M),
    };
    try {
      new Function('Module', `${glueSrc}\n//# sourceURL=sherpa-onnx-wasm-main-tts.js`)(M);
    } catch (e) { reject(e); }
  });
}

async function init(files: Map<string, Uint8Array>) {
  const M: any = await loadWasm();
  const api = loadTtsApi();

  // 模型文件写进 wasm 自带的内存文件系统
  const dir = '/kokoro';
  M.FS_createPath('/', 'kokoro', true, true);
  for (const [name, data] of files) M.FS_createDataFile(dir, name, data, true, true, true);

  const p = (n: string) => `${dir}/${n}`;
  const empty = {
    vits: { model: '', lexicon: '', tokens: '', dataDir: '', noiseScale: 0.667, noiseScaleW: 0.8, lengthScale: 1 },
    matcha: { acousticModel: '', vocoder: '', lexicon: '', tokens: '', dataDir: '', noiseScale: 0.667, lengthScale: 1 },
    kitten: { model: '', voices: '', tokens: '', dataDir: '', lengthScale: 1, lexicon: '' },
    zip: { tokens: '', encoder: '', decoder: '', vocoder: '', dataDir: '', lexicon: '', featScale: 0.1, tShift: 0.5, targetRMS: 0.1, guidanceScale: 1 },
    pocket: { lmFlow: '', lmMain: '', encoder: '', decoder: '', textConditioner: '', vocabJson: '', tokenScoresJson: '', voiceEmbeddingCacheCapacity: 50 },
    sup: { durationPredictor: '', textEncoder: '', vectorEstimator: '', vocoder: '', ttsJson: '', unicodeIndexer: '', voiceStyle: '' },
  };
  tts = api.createOfflineTts(M, {
    offlineTtsModelConfig: {
      offlineTtsVitsModelConfig: empty.vits,
      offlineTtsMatchaModelConfig: empty.matcha,
      offlineTtsKokoroModelConfig: {
        model: p('model.onnx'), voices: p('voices.bin'), tokens: p('tokens.txt'), dataDir: '', lengthScale: 1,
        lexicon: `${p('lexicon-us-en.txt')},${p('lexicon-zh.txt')}`, lang: '',
      },
      offlineTtsKittenModelConfig: empty.kitten,
      offlineTtsZipVoiceModelConfig: empty.zip,
      offlineTtsPocketModelConfig: empty.pocket,
      offlineTtsSupertonicModelConfig: empty.sup,
      numThreads: 1, debug: 0, provider: 'cpu',
    },
    ruleFsts: `${p('phone-zh.fst')},${p('date-zh.fst')},${p('number-zh.fst')}`,
    ruleFars: '', maxNumSentences: 1,
  }) as Tts;
  // 模型已载入引擎，内存文件系统里的副本不再需要
  for (const name of files.keys()) { try { M.FS_unlink(`${dir}/${name}`); } catch { /* 删不掉不影响使用 */ } }
}

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  if (m.type === 'init') {
    try {
      await init(new Map(m.files));
      post({ type: 'ready', sampleRate: tts!.sampleRate, numSpeakers: tts!.numSpeakers });
    } catch (e) {
      post({ type: 'initError', message: e instanceof Error ? `${e.message} ${e.stack ?? ''}` : String(e) });
    }
  } else if (m.type === 'synth') {
    try {
      if (!tts) throw new Error('语音引擎还没有加载');
      const a = tts.generate({ text: m.text, sid: m.sid, speed: m.speed });
      if (!a.samples.length) throw new Error('这句话没有合成出声音');
      post({ type: 'audio', id: m.id, samples: a.samples, sampleRate: a.sampleRate }, [a.samples.buffer]);
    } catch (e) {
      post({ type: 'fail', id: m.id, message: e instanceof Error ? e.message : String(e) });
    }
  }
};
