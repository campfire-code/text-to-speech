// 导入文案：txt（一行一条）、csv、xlsx（读第一个可见工作表）。Excel 读取基于 exceljs（MIT）。
import ExcelJS from 'exceljs';
import { cleanText } from './core';

/** 文本解码：优先 UTF-8（去掉 BOM），不是合法 UTF-8 时按 GBK 解（Excel 中文版导出的 CSV 常见） */
export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('gbk').decode(bytes);
  }
}

/** 解析 CSV：支持引号、引号内换行与逗号、两个引号转义，自动识别逗号 / 制表符 / 分号分隔 */
export function parseCsv(text: string): string[][] {
  const nl = text.indexOf('\n');
  const firstLine = text.slice(0, nl === -1 ? text.length : nl);
  const sep = [',', '\t', ';'].map((s) => [s, firstLine.split(s).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v) return cellText((v as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue);
    if ('richText' in v) return (v as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join('');
    if ('text' in v) return String((v as ExcelJS.CellHyperlinkValue).text);
    if ('error' in v) return '';
  }
  return String(v);
}

/** 读成二维字符串表。txt 每行一个单元格 */
export async function readGrid(bytes: Uint8Array, fileName: string): Promise<string[][]> {
  if (/\.txt$/i.test(fileName)) return cleanText(decodeText(bytes)).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => [l]);
  if (/\.csv$/i.test(fileName)) return parseCsv(cleanText(decodeText(bytes)));
  if (/\.xls$/i.test(fileName)) throw new Error('旧版 .xls 格式不支持，请用 Excel 或 WPS 另存为 .xlsx 后再导入');
  if (!/\.xlsx$/i.test(fileName)) throw new Error('只支持 txt、csv、xlsx 文件');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const ws = wb.worksheets.find((s) => s.state === 'visible');
  if (!ws) throw new Error('表格里没有可见的工作表');
  const grid: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    grid.push((row.values as ExcelJS.CellValue[]).slice(1).map(cellText));
  });
  return grid.filter((r) => r.some((c) => c.trim() !== ''));
}

const HEADER_WORDS = ['文案', '文本', '内容', '台词', '口播', '脚本', '配音', '正文', 'text', 'content', 'script', 'voice'];
/** 列名一般很短；很长的单元格即使含「文案」二字也是正文，不当表头 */
const isHeaderWord = (s: string) => s.trim().length <= 8 && HEADER_WORDS.some((w) => s.trim().toLowerCase().includes(w));

/**
 * 猜该读哪一列、第一行是不是表头：
 * 第一行有「文案 / 内容 / 台词…」之类的列名就用那一列并跳过表头；否则取前 50 行里平均最长的一列，不跳过。
 */
export function guessColumn(grid: string[][]): { col: number; header: boolean } {
  const width = Math.max(0, ...grid.map((r) => r.length));
  const hit = (grid[0] ?? []).findIndex((c) => isHeaderWord(c ?? ''));
  if (hit >= 0 && grid.length > 1) return { col: hit, header: true };
  let best = 0;
  let bestAvg = -1;
  for (let c = 0; c < width; c++) {
    const rows = grid.slice(0, 50);
    const avg = rows.reduce((n, r) => n + (r[c] ?? '').length, 0) / (rows.length || 1);
    if (avg > bestAvg) { best = c; bestAvg = avg; }
  }
  return { col: best, header: false };
}

export function gridEntries(grid: string[][], col: number, skipHeader: boolean): string[] {
  return grid.slice(skipHeader ? 1 : 0).map((r) => cleanText(r[col] ?? '').replace(/\n+/g, ' ').trim()).filter(Boolean);
}

/** 列选择框里显示的名称：第一行内容截短，没有就写「第 N 列」 */
export function columnLabels(grid: string[][], header: boolean): string[] {
  const width = Math.max(0, ...grid.map((r) => r.length));
  return Array.from({ length: width }, (_, i) => {
    const h = header ? (grid[0]?.[i] ?? '').trim() : '';
    return h ? `第 ${i + 1} 列：${[...h].slice(0, 10).join('')}` : `第 ${i + 1} 列`;
  });
}
