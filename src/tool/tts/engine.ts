// 语音引擎：在 Web Worker 里加载 Kokoro 模型，对外提供「文字 → 采样」的 synth 函数。
import type { FromWorker, ToWorker } from './tts.worker';

export interface Synthesized { samples: Float32Array; sampleRate: number }
export type Synth = (text: string, sid: number, speed: number) => Promise<Synthesized>;

export interface TtsEngine {
  sampleRate: number;
  numSpeakers: number;
  synth: Synth;
  dispose(): void;
}

/** 载入引擎。files 是已校验过的模型文件；失败时抛出带原因的错误 */
export function loadEngine(files: Map<string, Uint8Array>): Promise<TtsEngine> {
  const worker = new Worker(new URL('./tts.worker.ts', import.meta.url), { type: 'module' });
  const pending = new Map<number, { ok: (a: Synthesized) => void; fail: (e: Error) => void }>();
  let nextId = 1;
  const send = (m: ToWorker, transfer: Transferable[] = []) => worker.postMessage(m, transfer);
  const failAll = (e: Error) => { pending.forEach((p) => p.fail(e)); pending.clear(); };

  return new Promise<TtsEngine>((resolve, reject) => {
    worker.onerror = (ev) => {
      const e = new Error(`语音引擎出错：${ev.message || '未知原因'}`);
      failAll(e);
      reject(e);
    };
    worker.onmessage = (ev: MessageEvent<FromWorker>) => {
      const m = ev.data;
      if (m.type === 'ready') {
        resolve({
          sampleRate: m.sampleRate,
          numSpeakers: m.numSpeakers,
          synth: (text, sid, speed) => new Promise((ok, fail) => {
            const id = nextId++;
            pending.set(id, { ok, fail });
            send({ type: 'synth', id, text, sid, speed });
          }),
          dispose: () => { failAll(new Error('语音引擎已关闭')); worker.terminate(); },
        });
      } else if (m.type === 'initError') {
        worker.terminate();
        reject(new Error(`语音引擎加载失败：${m.message}`));
      } else {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.type === 'audio') p.ok({ samples: m.samples, sampleRate: m.sampleRate });
        else p.fail(new Error(m.message));
      }
    };
    const entries = [...files.entries()];
    // 传输所有权，避免复制一份 170 MB 的数据；主线程里的缓冲区之后不再使用
    send({ type: 'init', files: entries }, entries.map(([, d]) => d.buffer as ArrayBuffer));
  });
}
