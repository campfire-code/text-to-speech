// 生成 samples/ 里的示例文件（只在设置了 MAKE_SAMPLES=1 时运行）
import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { SAMPLE_ROWS, SAMPLE_TEXT } from './samples';

it.runIf(process.env.MAKE_SAMPLES === '1')('生成示例文件', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('配音文案');
  ws.addRow(['序号', '配音文案', '备注']).font = { bold: true };
  SAMPLE_ROWS.forEach((r) => ws.addRow(r));
  ws.getColumn(2).width = 56;
  writeFileSync('samples/示例文案.xlsx', new Uint8Array(await wb.xlsx.writeBuffer()));
  writeFileSync('samples/示例文案.txt', SAMPLE_TEXT + '\n');
});
