// 主界面：输入 / 导入文案 → 选音色和语速 → 离线合成 → 导出 WAV / MP3 与对齐的 SRT。
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileSpreadsheet, FolderOpen, Play, Square, Trash2, Volume2 } from 'lucide-react';
import type { CustomTool } from '../kit/types';
import { ProgressBar, useDroppedFiles } from '../kit/parts';
import { defaultOutputDir, fileSrc, fs, openFolder, pickFiles, pickFolder, reveal, settingsStore } from '../kit/platform';
import { encodeWav, fmtDuration, parseEntries, runFolderName } from './core';
import { countSentences, runJob, type Failure, type OutputFile, type Progress } from './flow';
import { columnLabels, gridEntries, guessColumn, readGrid } from './table';
import { flowDeps, modelState, prepareEngine, type ModelState, type Stage } from './runtime';
import { KOKORO, VOICE_GROUPS, voiceList, sizeMB, DEFAULT_SID } from './tts/models';
import { SAMPLE_TEXT } from './samples';
import { demoDir, demoFiles, demoText } from './preview';
import './tool.css';

type Ctx = Parameters<CustomTool['Main']>[0]['ctx'];
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const isPreview = typeof location !== 'undefined' && location.pathname.endsWith('preview.html');
const IMPORT_EXTS = ['txt', 'csv', 'xlsx'];
const AUDITION = '你好，这是一段试听。Hello, this is a voice test，一二三四五。';
const VOICES = voiceList();

interface Prefs {
  sid: number; speed: number; format: 'wav' | 'mp3'; srt: boolean; mode: 'each' | 'merge';
  sentenceGap: number; entryGap: number; maxLine: number; localDir: string; outDir: string;
}
const DEFAULT_PREFS: Prefs = { sid: DEFAULT_SID, speed: 1, format: 'mp3', srt: true, mode: 'each', sentenceGap: 0.35, entryGap: 0.8, maxLine: 24, localDir: '', outDir: '' };

async function loadPrefs(): Promise<Prefs> {
  try {
    return { ...DEFAULT_PREFS, ...(await (await settingsStore()).get<Partial<Prefs>>('prefs')) };
  } catch {
    return DEFAULT_PREFS;
  }
}
async function savePrefs(p: Prefs) {
  try { await (await settingsStore()).set('prefs', p); } catch { /* 存不下不影响使用 */ }
}

interface Table { name: string; grid: string[][]; col: number; header: boolean }

export function Main({ ctx }: { ctx?: Ctx }) {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [text, setText] = useState(isPreview ? demoText : '');
  const [table, setTable] = useState<Table | null>(null);
  const [stage, setStage] = useState<Stage | null>(null);
  const [prog, setProg] = useState<Progress | null>(null);
  const [files, setFiles] = useState<OutputFile[]>(isPreview ? demoFiles : []);
  const [failed, setFailed] = useState<Failure[]>([]);
  const [dir, setDir] = useState(isPreview ? demoDir : '');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [model, setModel] = useState<ModelState>(isPreview ? 'cached' : 'missing');
  const [auditioning, setAuditioning] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const busy = stage !== null;

  useEffect(() => { if (!isPreview) void loadPrefs().then(setPrefs); }, []);
  useEffect(() => { if (!isPreview) void modelState(prefs.localDir).then(setModel).catch(() => setModel('missing')); }, [prefs.localDir]);
  const setPref = <K extends keyof Prefs>(k: K, v: Prefs[K]) => setPrefs((p) => { const n = { ...p, [k]: v }; void savePrefs(n); return n; });

  const deferred = useDeferredValue(text);
  const entries = useMemo(() => parseEntries(deferred), [deferred]);
  const sentences = useMemo(() => countSentences(entries), [entries]);
  const chars = useMemo(() => entries.reduce((n, e) => n + [...e].length, 0), [entries]);

  // ---------- 导入 ----------
  const importFile = useCallback(async (path: string) => {
    if (busy) return;
    const name = baseName(path);
    if (!IMPORT_EXTS.includes((name.split('.').pop() ?? '').toLowerCase())) { setMsg({ kind: 'err', text: `不支持这种文件：${name}。支持 txt、csv、xlsx（.xls 请先另存为 .xlsx）` }); return; }
    try {
      const grid = await readGrid(await fs.readFile(path), name);
      if (!grid.length) throw new Error('文件里没有内容');
      const isTxt = /\.txt$/i.test(name);
      const g = isTxt ? { col: 0, header: false } : guessColumn(grid);
      const list = gridEntries(grid, g.col, g.header);
      if (!list.length) throw new Error('没有读到可以配音的文字');
      setTable(isTxt ? null : { name, grid, ...g });
      setText(list.join('\n'));
      setMsg({ kind: 'ok', text: `已导入 ${name}，共 ${list.length} 条${isTxt ? '' : `（读取第 ${g.col + 1} 列）`}` });
    } catch (e) {
      setMsg({ kind: 'err', text: `导入失败：${errText(e)}` });
    }
  }, [busy]);
  const hover = useDroppedFiles((paths) => paths[0] && void importFile(paths[0]));
  const retable = (t: Table) => { setTable(t); setText(gridEntries(t.grid, t.col, t.header).join('\n')); };

  // ---------- 引擎 ----------
  async function engine(signal: AbortSignal) {
    try {
      const e = await prepareEngine(prefs.localDir, setStage, signal);
      setModel('loaded');
      return e;
    } catch (err) {
      void modelState(prefs.localDir).then(setModel).catch(() => {});
      throw err;
    }
  }

  async function audition() {
    if (busy || auditioning) return;
    const ac = new AbortController();
    abort.current = ac;
    setMsg(null); setAuditioning(true); setStage({ step: 'load', ratio: 0, text: '准备试听…' });
    try {
      const e = await engine(ac.signal);
      setStage({ step: 'synth', ratio: 0, text: '正在合成试听…' });
      const a = await e.synth(AUDITION, prefs.sid, prefs.speed);
      const url = URL.createObjectURL(new Blob([encodeWav(a.samples, a.sampleRate) as BlobPart], { type: 'audio/wav' }));
      const el = audio.current;
      if (el) { el.src = url; void el.play().catch(() => {}); }
    } catch (e) {
      setMsg({ kind: 'err', text: ac.signal.aborted ? '已取消' : errText(e) });
    } finally {
      setStage(null); setAuditioning(false); abort.current = null;
    }
  }

  async function start() {
    if (!ctx || !entries.length) return;
    const ac = new AbortController();
    abort.current = ac;
    setMsg(null); setFiles([]); setFailed([]); setProg(null); setStage({ step: 'load', ratio: 0, text: '准备中…' });
    try {
      const e = await engine(ac.signal);
      const base = prefs.outDir || (await defaultOutputDir('文案转配音'));
      const outDir = await ctx.join(base, runFolderName(new Date()));
      const deps = await flowDeps(ctx, e);
      const res = await runJob({ entries, sid: prefs.sid, speed: prefs.speed, format: prefs.format, srt: prefs.srt, mode: prefs.mode, sentenceGap: prefs.sentenceGap, entryGap: prefs.entryGap, maxLine: prefs.maxLine, outDir },
        deps, (p) => { setProg(p); setStage({ step: 'synth', ratio: p.ratio, text: `正在合成：第 ${p.entry} / ${p.entries} 条（已完成 ${p.doneSentences} / ${p.totalSentences} 句）` }); }, ac.signal);
      setFiles(res.files); setFailed(res.failed); setDir(outDir);
      setMsg(res.files.length
        ? { kind: res.failed.length ? 'err' : 'ok', text: `完成：生成 ${res.files.length} 个音频${prefs.srt ? '和对应的 SRT 字幕' : ''}${res.failed.length ? `，${res.failed.length} 条失败（见下方）` : ''}。` }
        : { kind: 'err', text: '没有生成任何音频，原因见下方' });
    } catch (e) {
      setMsg({ kind: 'err', text: ac.signal.aborted ? '已取消（已生成的文件保留在输出文件夹里）' : errText(e) });
    } finally {
      setStage(null); setProg(null); abort.current = null;
    }
  }

  const play = (p: string) => { const el = audio.current; if (el) { el.src = fileSrc(p); void el.play().catch(() => {}); } };
  const modelText = model === 'loaded' ? '已加载，可离线使用' : model === 'cached' ? (prefs.localDir ? '使用本地模型文件夹' : '已下载，可离线使用') : '尚未下载，首次合成或试听时自动下载';

  return (
    <div className="tt-root">
      <div className="tt-main">
        <section className={`k-panel tt-text${hover ? ' hover' : ''}`}>
          <div className="tt-hd">
            <b>文案</b>
            {isPreview && <span className="tt-badge ok">示例数据</span>}
            <span className="k-muted k-num" role="status">{entries.length} 条 · {sentences} 句 · {chars} 字</span>
            <span className="tt-sp" />
            <button className="k-btn tt-sm" disabled={busy} onClick={async () => { const p = (await pickFiles(IMPORT_EXTS, '文案文件'))[0]; if (p) void importFile(p); }}><FileSpreadsheet size={14} aria-hidden />导入 txt / Excel…</button>
            <button className="k-btn tt-sm" disabled={busy} onClick={() => { setText(SAMPLE_TEXT); setTable(null); }}>填入示例</button>
            <button className="k-btn tt-sm" disabled={busy || !text} onClick={() => { setText(''); setTable(null); }}><Trash2 size={14} aria-hidden />清空</button>
          </div>
          {table && (
            <div className="tt-table">
              <span className="k-muted">来自 {table.name}</span>
              <select className="k-input tt-col" aria-label="读取哪一列" value={table.col} disabled={busy} onChange={(e) => retable({ ...table, col: Number(e.target.value) })}>
                {columnLabels(table.grid, table.header).map((l, i) => <option key={i} value={i}>{l}</option>)}
              </select>
              <label className="tt-check"><input type="checkbox" checked={table.header} disabled={busy} onChange={(e) => retable({ ...table, header: e.target.checked })} /><span>第一行是表头，不合成</span></label>
            </div>
          )}
          <textarea className="k-textarea tt-area" aria-label="配音文案，每行一条" placeholder={'一行一条，每条生成一个音频。\n也可以把 txt / Excel 文件拖到这里。\n\n例如：\n大家好，欢迎来到今天的分享。\n这款产品一共有三种颜色。'}
            value={text} disabled={busy} spellCheck={false} onChange={(e) => { setText(e.target.value); setTable(null); }} />
          <div className="tt-foot k-muted">每行是一条文案，一条里的多句话会按句号、问号、感叹号自动切开，逐句合成后拼起来。{hover ? '松开即可导入' : ''}</div>
        </section>

        <section className="k-panel tt-opts">
          <div className="tt-field">
            <label className="k-label" htmlFor="tt-voice">音色</label>
            <div className="tt-row">
              <select id="tt-voice" className="k-input tt-grow" value={prefs.sid} disabled={busy} onChange={(e) => setPref('sid', Number(e.target.value))}>
                {VOICE_GROUPS.map((g) => <optgroup key={g.id} label={`${g.label}（${g.count} 个）`}>{VOICES.filter((v) => v.group === g.id).map((v) => <option key={v.sid} value={v.sid}>{v.label}</option>)}</optgroup>)}
              </select>
              <button className="k-btn tt-sm" disabled={busy} onClick={audition} title="用当前音色和语速合成一小段"><Volume2 size={14} aria-hidden />试听</button>
            </div>
          </div>
          <div className="tt-field">
            <label className="k-label" htmlFor="tt-speed">语速 <b className="k-num">{prefs.speed.toFixed(2)}×</b></label>
            <input id="tt-speed" className="tt-range" type="range" min={0.6} max={1.6} step={0.05} value={prefs.speed} disabled={busy} onChange={(e) => setPref('speed', Number(e.target.value))} />
          </div>
          <div className="tt-pair">
            <div className="tt-field"><span className="k-label">格式</span>
              <span className="k-seg" role="group" aria-label="输出格式">
                {(['mp3', 'wav'] as const).map((f) => <button key={f} className={prefs.format === f ? 'on' : ''} aria-pressed={prefs.format === f} disabled={busy} onClick={() => setPref('format', f)}>{f.toUpperCase()}</button>)}
              </span>
            </div>
            <div className="tt-field"><span className="k-label">输出方式</span>
              <span className="k-seg" role="group" aria-label="输出方式">
                {([['each', '每条一个文件'], ['merge', '合成一个文件']] as const).map(([k, l]) => <button key={k} className={prefs.mode === k ? 'on' : ''} aria-pressed={prefs.mode === k} disabled={busy} onClick={() => setPref('mode', k)}>{l}</button>)}
              </span>
            </div>
          </div>
          <div className="tt-pair">
            <div className="tt-field"><label className="k-label" htmlFor="tt-gap">句间停顿</label>
              <select id="tt-gap" className="k-input" value={prefs.sentenceGap} disabled={busy} onChange={(e) => setPref('sentenceGap', Number(e.target.value))}>
                {[0.15, 0.35, 0.6, 1].map((v) => <option key={v} value={v}>{v} 秒</option>)}
              </select>
            </div>
            {prefs.mode === 'merge' && <div className="tt-field"><label className="k-label" htmlFor="tt-egap">条间停顿</label>
              <select id="tt-egap" className="k-input" value={prefs.entryGap} disabled={busy} onChange={(e) => setPref('entryGap', Number(e.target.value))}>
                {[0.4, 0.8, 1.5, 3].map((v) => <option key={v} value={v}>{v} 秒</option>)}
              </select>
            </div>}
          </div>
          <div className="tt-field">
            <label className="tt-check"><input type="checkbox" checked={prefs.srt} disabled={busy} onChange={(e) => setPref('srt', e.target.checked)} /><span>同时导出对齐的 SRT 字幕</span></label>
            {prefs.srt && <div className="tt-row"><label className="k-label" htmlFor="tt-line">每行字幕最多</label>
              <select id="tt-line" className="k-input" value={prefs.maxLine} disabled={busy} onChange={(e) => setPref('maxLine', Number(e.target.value))}>
                <option value={16}>16 字（竖屏）</option><option value={24}>24 字</option><option value={32}>32 字</option>
              </select></div>}
          </div>
          <div className="tt-field">
            <span className="k-label">保存到</span>
            <div className="tt-row">
              <span className="tt-path k-ellipsis" title={prefs.outDir || '下载文件夹 / 文案转配音'}>{prefs.outDir || '下载文件夹 / 文案转配音'}</span>
              <button className="k-btn tt-sm" disabled={busy} onClick={async () => { const d = await pickFolder(); if (d) setPref('outDir', d); }}><FolderOpen size={14} aria-hidden />选择…</button>
            </div>
            <span className="k-muted tt-hint">每次合成会新建一个带时间的子文件夹，不会覆盖旧文件。</span>
          </div>
        </section>
      </div>

      <section className="k-panel tt-model">
        <div className="tt-model-info">
          <b>语音模型</b>
          <span>{KOKORO.label}，103 个音色，中英文混读，约 {sizeMB(KOKORO)} MB</span>
          <span className={`tt-badge ${model === 'missing' ? 'warn' : 'ok'}`}>{modelText}</span>
        </div>
        <div className="tt-row">
          <span className="k-muted tt-hint">模型许可证 Apache-2.0。下载后保存在本机，合成全程离线。下载不了可手动下载同名文件并指定文件夹。</span>
          <button className="k-btn tt-sm" disabled={busy} onClick={async () => { const d = await pickFolder(); if (d) setPref('localDir', d); }}><FolderOpen size={14} aria-hidden />指定本地模型文件夹…</button>
          {prefs.localDir && <button className="k-btn tt-sm" disabled={busy} onClick={() => setPref('localDir', '')} title={prefs.localDir}>改回自动下载</button>}
        </div>
      </section>

      <section className="k-panel tt-go">
        {busy
          ? <button className="k-btn" onClick={() => abort.current?.abort()}><Square size={14} aria-hidden />取消</button>
          : <button className="k-btn primary" disabled={!ctx || !entries.length} onClick={start}><Play size={14} aria-hidden />开始合成（{entries.length} 条）</button>}
        <div className="tt-prog">
          {stage ? <><ProgressBar ratio={stage.ratio} label={stage.text} /><span className="k-muted" role="status">{stage.text}{prog && prog.totalSentences > 20 ? '（合成速度约为播放时长的 1～2 倍，请耐心等待）' : ''}</span></>
            : <span className="k-muted">{entries.length ? '合成在本机进行，不联网（仅首次需要下载模型），不需要显卡。' : '先在左边输入或导入文案。'}</span>}
        </div>
      </section>

      {msg && <div className={`tt-msg ${msg.kind}`} role={msg.kind === 'err' ? 'alert' : 'status'}>{msg.kind === 'ok' ? <CheckCircle2 size={15} aria-hidden /> : <AlertTriangle size={15} aria-hidden />}<span>{msg.text}</span></div>}

      {(files.length > 0 || failed.length > 0) && (
        <section className="k-panel tt-res">
          <div className="tt-hd">
            <b>结果</b>
            <span className="k-muted k-num">{files.length} 个文件</span>
            <span className="tt-sp" />
            {dir && <button className="k-btn tt-sm" onClick={() => void openFolder(dir)}><FolderOpen size={14} aria-hidden />打开文件夹</button>}
          </div>
          <ul className="tt-list">
            {files.map((f) => (
              <li key={f.path} className="tt-item">
                <button className="k-icon-btn" aria-label={`播放 ${f.name}`} title="播放" onClick={() => play(f.path)}><Play size={14} /></button>
                <span className="tt-name k-ellipsis" title={f.path}>{f.name}</span>
                <span className="k-muted k-num">{fmtDuration(f.seconds)}</span>
                <span className="k-muted">{f.entries.length > 1 ? `${f.entries.length} 条` : ''}{f.srtPath ? ' · 含 SRT' : ''}</span>
                <button className="k-btn tt-sm" onClick={() => void reveal(f.path).catch(() => {})}>在文件夹中显示</button>
              </li>
            ))}
            {failed.map((f) => (
              <li key={`f${f.index}`} className="tt-item bad">
                <AlertTriangle size={14} aria-hidden />
                <span className="tt-name k-ellipsis" title={f.text}>第 {f.index + 1} 条：{f.text}</span>
                <span className="tt-err">{f.error}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <audio ref={audio} className="tt-audio" controls aria-label="试听播放器" />
      <div className="tt-ai k-muted">合成的配音属于 AI 合成内容。用于商业发布时，请遵守所用模型的许可证（Kokoro 为 Apache-2.0）和发布平台对 AI 合成内容的标识要求。</div>
    </div>
  );
}
