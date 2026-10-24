import { describe, expect, it } from 'vitest';
import {
  cleanCue, composeTrack, encodeWav, entryFileName, fmtDuration, hasSpeakable, mp3Args, parseEntries, runFolderName, snippet, splitCue, splitSentences, srtTime, toSrt, weight,
} from './core';

describe('parseEntries 拆条', () => {
  it('一行一条，去掉空行、首尾空白、零宽字符和 \\r', () => {
    expect(parseEntries('  第一条 \r\n\r\n​第二条\n   \n第三条\n')).toEqual(['第一条', '第二条', '第三条']);
  });
  it('空文本得到空数组', () => expect(parseEntries(' \n\n')).toEqual([]));
});

describe('splitSentences 分句', () => {
  it('按中文句末标点切分，标点留在句尾', () => {
    expect(splitSentences('你好。今天天气不错！出去走走吗？好的；走吧')).toEqual(['你好。', '今天天气不错！', '出去走走吗？', '好的；', '走吧']);
  });
  it('英文句号后跟空格才切，小数、型号、网址里的点不切', () => {
    expect(splitSentences('Price is 99.5 yuan. Use Type-C v1.2 now.')).toEqual(['Price is 99.5 yuan.', 'Use Type-C v1.2 now.']);
  });
  it('句末标点后面的引号 / 括号跟着前一句', () => {
    expect(splitSentences('他说：“好的。”然后走了。')).toEqual(['他说：“好的。”', '然后走了。']);
  });
  it('省略号整体算句末；连续标点不产生空句', () => {
    expect(splitSentences('等一下……我想想！！！好了')).toEqual(['等一下……', '我想想！！！', '好了']);
  });
  it('只有标点的片段并入上一句，整段都没有可读文字时返回空', () => {
    expect(splitSentences('好的。。。')).toEqual(['好的。。。']);
    expect(splitSentences('？！……')).toEqual([]);
    expect(splitSentences('')).toEqual([]);
  });
  it('超长的句子先按逗号等弱标点拆，不超过上限', () => {
    const s = '第一段内容在这里，第二段内容在这里，第三段内容在这里，第四段内容在这里。';
    const out = splitSentences(s, 20);
    expect(out.every((x) => [...x].length <= 20)).toBe(true);
    expect(out.join('')).toBe(s);
    expect(out.length).toBeGreaterThan(1);
  });
  it('没有任何标点的超长句硬切，英文尽量在空格处断开，内容不丢', () => {
    const zh = '字'.repeat(45);
    expect(splitSentences(zh, 20).map((x) => [...x].length)).toEqual([20, 20, 5]);
    const en = 'one two three four five six seven eight nine ten';
    const out = splitSentences(en, 15);
    expect(out.every((x) => x.length <= 15)).toBe(true);
    expect(out.join(' ')).toBe(en);
  });
  it('文案内的换行当作句子分隔', () => {
    expect(splitSentences('第一行\n第二行')).toEqual(['第一行。', '第二行']);
  });
  it('hasSpeakable', () => {
    expect(hasSpeakable('。。。')).toBe(false);
    expect(hasSpeakable('a')).toBe(true);
    expect(hasSpeakable('3')).toBe(true);
  });
});

describe('字幕行', () => {
  it('cleanCue 去掉行首行尾的逗号句号，保留问号叹号', () => {
    expect(cleanCue('你好，')).toBe('你好');
    expect(cleanCue('真的吗？')).toBe('真的吗？');
    expect(cleanCue('，好的。')).toBe('好的');
  });
  it('splitCue 按小句打包，每行不超过上限', () => {
    expect(splitCue('今天上新三款，限时五折，先到先得。', 6)).toEqual(['今天上新三款', '限时五折', '先到先得']);
    expect(splitCue('今天上新三款，限时五折，先到先得。', 10)).toEqual(['今天上新三款', '限时五折，先到先得']);
    expect(splitCue('今天上新三款，限时五折，先到先得。', 20)).toEqual(['今天上新三款，限时五折，先到先得']);
    expect(splitCue('短句。', 20)).toEqual(['短句']);
  });
  it('splitCue 单个小句超长时硬切，内容不丢', () => {
    const lines = splitCue('字'.repeat(30), 12);
    expect(lines.map((l) => l.length)).toEqual([12, 12, 6]);
  });
  it('splitCue 英文按宽度算（字母算半个汉字宽），不在单词中间断开', () => {
    // 英文部分宽 15，中文部分宽 10.5，合计 25.5
    expect(splitCue('Today we have a limited offer, 数量不多，先到先得！', 26)).toEqual(['Today we have a limited offer, 数量不多，先到先得！']);
    expect(splitCue('Today we have a limited offer, 数量不多，先到先得！', 24)).toEqual(['Today we have a limited offer, 数量不多', '先到先得！']);
    expect(splitCue('one two three four five six seven eight nine ten', 10)).toEqual(['one two three four', 'five six seven eight', 'nine ten']);
  });
  it('weight：汉字数字各 1，英文字母 0.3，不计标点和空白，至少为 1', () => {
    expect(weight('你好，世界！')).toBe(4);
    expect(weight('。。')).toBe(1);
    expect(weight('2024年')).toBe(5);
    expect(weight('ab c')).toBeCloseTo(1, 9);
    expect(weight('hello world')).toBeCloseTo(3, 9);
  });
});

const sine = (n: number) => new Float32Array(n).fill(0.5);

describe('composeTrack 时间轴', () => {
  // 采样率 1000：1 个采样 = 1 毫秒，便于核对
  it('用每句的实际采样数算时间，句间插入停顿；最后一句后不加停顿', () => {
    const t = composeTrack([[{ text: '第一句。', samples: sine(1000) }, { text: '第二句。', samples: sine(2500) }]], 1000, 0.4, 0, 24);
    expect(t.cues).toEqual([
      { start: 0, end: 1, text: '第一句' },
      { start: 1.4, end: 3.9, text: '第二句' },
    ]);
    expect(t.samples.length).toBe(1000 + 400 + 2500);
    expect(t.ranges).toEqual([{ start: 0, end: 3.9 }]);
    // 停顿段是静音，语音段保持原值
    expect(t.samples[999]).toBe(0.5);
    expect(t.samples[1000]).toBe(0);
    expect(t.samples[1399]).toBe(0);
    expect(t.samples[1400]).toBe(0.5);
  });
  it('多条文案：条间停顿，ranges 记录每条的起止', () => {
    const t = composeTrack([[{ text: '甲。', samples: sine(500) }], [{ text: '乙。', samples: sine(700) }]], 1000, 0.3, 1, 24);
    expect(t.ranges).toEqual([{ start: 0, end: 0.5 }, { start: 1.5, end: 2.2 }]);
    expect(t.cues.map((c) => [c.start, c.end, c.text])).toEqual([[0, 0.5, '甲'], [1.5, 2.2, '乙']]);
  });
  it('一句话拆成多行字幕时按字数比例分摊实际时长，首尾相接，最后一行结束于这句的结束', () => {
    const t = composeTrack([[{ text: '一二三，四五六七八九。', samples: sine(9000) }]], 1000, 0.3, 0, 4);
    // 小句「一二三，」权重 3，「四五六七八九。」权重 6，maxLine=4 → 第二个小句被硬切为 4+2
    expect(t.cues.map((c) => c.text)).toEqual(['一二三', '四五六七', '八九']);
    expect(t.cues[0].start).toBe(0);
    expect(t.cues.at(-1)!.end).toBe(9);
    for (let i = 1; i < t.cues.length; i++) expect(t.cues[i].start).toBeCloseTo(t.cues[i - 1].end, 9);
    // 权重 3 : 4 : 2 → 3、4、2 秒
    expect(t.cues.map((c) => c.end - c.start)).toEqual([3, 4, 2]);
  });
  it('空输入得到空音轨', () => {
    const t = composeTrack([], 24000, 0.3, 1, 24);
    expect(t.samples.length).toBe(0);
    expect(t.cues).toEqual([]);
  });
});

describe('SRT', () => {
  it('srtTime 格式与进位', () => {
    expect(srtTime(0)).toBe('00:00:00,000');
    expect(srtTime(61.0054)).toBe('00:01:01,005');
    expect(srtTime(3725.9996)).toBe('01:02:06,000');
    expect(srtTime(-1)).toBe('00:00:00,000');
  });
  it('toSrt：序号从 1 开始，空行分隔，结尾带换行', () => {
    const s = toSrt([{ start: 0, end: 1.5, text: '你好' }, { start: 2, end: 3.25, text: '再见' }]);
    expect(s).toBe('1\n00:00:00,000 --> 00:00:01,500\n你好\n\n2\n00:00:02,000 --> 00:00:03,250\n再见\n');
  });
});

describe('encodeWav', () => {
  it('44 字节头 + 16 位单声道数据，采样率与长度正确，超范围的值被截断', () => {
    const w = encodeWav(new Float32Array([0, 1, -1, 2, -2, 0.5]), 24000);
    const v = new DataView(w.buffer);
    const tag = (o: number) => String.fromCharCode(...w.subarray(o, o + 4));
    expect([tag(0), tag(8), tag(12), tag(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    expect(v.getUint32(4, true)).toBe(36 + 12);
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // 单声道
    expect(v.getUint32(24, true)).toBe(24000);
    expect(v.getUint32(28, true)).toBe(48000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(12);
    expect(w.length).toBe(44 + 12);
    expect([...Array(6)].map((_, i) => v.getInt16(44 + i * 2, true))).toEqual([0, 32767, -32768, 32767, -32768, 16384]);
  });
  it('NaN 当作静音，不会写出乱值', () => {
    const w = encodeWav(new Float32Array([NaN]), 24000);
    expect(new DataView(w.buffer).getInt16(44, true)).toBe(0);
  });
});

describe('文件命名', () => {
  it('序号补零（至少 2 位，随总数增加），后面跟文案开头的字', () => {
    expect(entryFileName(0, 5, '大家好，欢迎来到直播间。', 'mp3')).toBe('01-大家好欢迎来到直播间.mp3');
    expect(entryFileName(11, 120, 'Hello world', 'wav')).toBe('012-Helloworld.wav');
  });
  it('去掉文件名里的非法字符，全是标点时只剩序号', () => {
    expect(snippet('a/b:c*d?"e<f>g|h\\i')).toBe('abcdefghi');
    expect(entryFileName(2, 3, '？！', 'wav')).toBe('03.wav');
  });
  it('最多取 12 个字符，emoji 等符号不进文件名', () => {
    expect(snippet('一二三四五六七八九十零甲乙丙')).toBe('一二三四五六七八九十零甲');
    expect(snippet('😀'.repeat(20) + 'a')).toBe('a'); // emoji 属于符号类，被去掉
  });
  it('runFolderName', () => expect(runFolderName(new Date(2026, 9, 3, 8, 5, 9))).toBe('配音-20261003-080509'));
});

describe('ffmpeg 参数', () => {
  it('WAV 转 MP3：单声道、libmp3lame、192k，输入在前输出在后', () => {
    expect(mp3Args('/tmp/a.wav', '/out/a.mp3')).toEqual(['-i', '/tmp/a.wav', '-vn', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '192k', '/out/a.mp3']);
    expect(mp3Args('a.wav', 'a.mp3', 128).slice(-3)).toEqual(['-b:a', '128k', 'a.mp3']);
  });
});

describe('fmtDuration', () => {
  it('秒与分秒', () => {
    expect(fmtDuration(4.34)).toBe('4.3 秒');
    expect(fmtDuration(45.2)).toBe('45 秒');
    expect(fmtDuration(125)).toBe('2 分 05 秒');
  });
});
