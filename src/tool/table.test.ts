import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { columnLabels, decodeText, gridEntries, guessColumn, parseCsv, readGrid } from './table';

const enc = (s: string) => new TextEncoder().encode(s);

async function xlsx(rows: (string | number | null)[][], opts: { hiddenFirst?: boolean } = {}): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  if (opts.hiddenFirst) { const h = wb.addWorksheet('隐藏表'); h.addRow(['不该读到']); h.state = 'hidden'; }
  const ws = wb.addWorksheet('文案');
  rows.forEach((r) => ws.addRow(r));
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

describe('txt / csv', () => {
  it('txt 每个非空行一条', async () => {
    expect(await readGrid(enc('﻿第一条\r\n\r\n 第二条 \n'), 'a.txt')).toEqual([['第一条'], ['第二条']]);
  });
  it('csv：引号内的逗号和换行、转义引号', () => {
    expect(parseCsv('序号,文案\n1,"你好，世界"\n2,"他说""好""\n第二行"\n')).toEqual([['序号', '文案'], ['1', '你好，世界'], ['2', '他说"好"\n第二行']]);
  });
  it('csv 不是 UTF-8 时按 GBK 解码（Excel 中文版导出）', () => {
    const gbk = new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]); // 「你好」的 GBK 字节
    expect(decodeText(gbk)).toBe('你好');
  });
  it('.xls 给出明确提示，未知扩展名拒绝', async () => {
    await expect(readGrid(new Uint8Array(), 'a.xls')).rejects.toThrow('另存为 .xlsx');
    await expect(readGrid(new Uint8Array(), 'a.doc')).rejects.toThrow('只支持');
  });
});

describe('xlsx', () => {
  it('读第一个可见工作表，空行丢弃，数字转成文字', async () => {
    const bytes = await xlsx([['序号', '文案'], [1, '你好'], [null, null], [2, '再见']], { hiddenFirst: true });
    expect(await readGrid(bytes, 'a.xlsx')).toEqual([['序号', '文案'], ['1', '你好'], ['2', '再见']]);
  });
});

describe('选列与表头', () => {
  const grid = [['序号', '配音文案', '备注'], ['1', '这是第一条比较长的文案内容', 'a'], ['2', '这是第二条', 'b']];
  it('第一行有「文案 / 内容 / 台词」之类的列名：用那一列，并跳过表头', () => {
    expect(guessColumn(grid)).toEqual({ col: 1, header: true });
    expect(gridEntries(grid, 1, true)).toEqual(['这是第一条比较长的文案内容', '这是第二条']);
  });
  it('没有表头词：取平均最长的一列，不跳过第一行', () => {
    const g = [['1', '第一条文案内容比较长'], ['2', '第二条文案内容也不短']];
    expect(guessColumn(g)).toEqual({ col: 1, header: false });
    expect(gridEntries(g, 1, false)).toEqual(['第一条文案内容比较长', '第二条文案内容也不短']);
  });
  it('只有一行且像表头时不跳过（否则什么都读不到）', () => {
    expect(guessColumn([['文案']])).toEqual({ col: 0, header: false });
  });
  it('单元格里的换行压成空格，空单元格丢弃', () => {
    expect(gridEntries([['甲\n乙'], [''], ['丙']], 0, false)).toEqual(['甲 乙', '丙']);
  });
  it('列名标签', () => {
    expect(columnLabels(grid, true)).toEqual(['第 1 列：序号', '第 2 列：配音文案', '第 3 列：备注']);
    expect(columnLabels(grid, false)).toEqual(['第 1 列', '第 2 列', '第 3 列']);
  });
});
