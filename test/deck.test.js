import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { dedupeTimeline, assignNotes, sanitizeFilename, buildDeck, buildSessionDeck, DECK_LAYOUT, imagePlacement } from '../deck.js';
import { createApi } from '../api.js';

// 1x1 红色像素 PNG
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

test('dedupeTimeline：排序 + 相邻重复去重 + 丢弃空 URL', () => {
  const out = dedupeTimeline([
    { url: 'a', createdSec: 30 },
    { url: 'b', createdSec: 10 },
    { url: 'b', createdSec: 12 },
    { url: '', createdSec: 40 },
    { url: 'a', createdSec: 20 }, // 排序后与 a(30) 相邻，一并去重
  ]);
  assert.deepEqual(out, [
    { url: 'b', createdSec: 10 },
    { url: 'a', createdSec: 20 },
  ]);
});

test('assignNotes：转写落入对应页的时间窗', () => {
  const slides = [{ createdSec: 0 }, { createdSec: 60 }, { createdSec: 120 }];
  const lines = [
    { beginSec: 5, text: '第一页的话', label: '开课第00:05' },
    { beginSec: 70, text: '第二页开头', label: '开课第01:10' },
    { beginSec: 60, text: '恰好压在窗口起点', label: '开课第01:00' },
    { beginSec: 500, text: '最后一页', label: '开课第08:20' },
  ];
  const notes = assignNotes(slides, lines);
  assert.ok(notes[0].includes('第一页的话'));
  assert.ok(notes[1].includes('第二页开头'));
  assert.ok(notes[1].includes('恰好压在窗口起点'));
  assert.ok(notes[2].includes('最后一页'));
  assert.equal(assignNotes([], lines).length, 0);
});

test('sanitizeFilename：替换非法字符并截断', () => {
  assert.equal(sanitizeFilename('操作系统 2026-10-01 第3-4节'), '操作系统 2026-10-01 第3-4节');
  assert.equal(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
  assert.equal(sanitizeFilename(''), '课堂课件');
  assert.equal(sanitizeFilename('x'.repeat(100)).length, 80);
});

test('buildDeck：封面 + 图片页生成合法 PPTX（PK 头）', async () => {
  const { buffer, slideCount } = await buildDeck({
    title: '测试课件',
    subtitle: '第一课',
    slides: [
      { url: 'u1', createdSec: 0, notes: '备注一' },
      { url: 'u2', createdSec: 60 },
    ],
    fetchImage: async () => ({ buffer: TINY_PNG, type: 'image/png' }),
  });
  assert.equal(slideCount, 2);
  assert.equal(buffer.subarray(0, 2).toString(), 'PK');
  assert.ok(buffer.length > 10000);
});

// 从 PPTX（zip 容器）读取某个条目的内容：足够断言幻灯片画布尺寸
function readZipEntry(buffer, name) {
  let offset = 0;
  while (offset < buffer.length - 30) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) return null; // 本地文件头签名
    const method = buffer.readUInt16LE(offset + 8);
    const size = buffer.readUInt32LE(offset + 18);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLen + extraLen;
    if (buffer.subarray(nameStart, nameStart + nameLen).equals(Buffer.from(name, 'utf8'))) {
      const raw = buffer.subarray(dataStart, dataStart + size);
      return method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw);
    }
    offset = dataStart + size;
  }
  return null;
}

test('buildDeck：播放画布与图片框同为 16:9 宽版（修复播放只显示部分图片）', async () => {
  const { buffer } = await buildDeck({
    title: '尺寸测试',
    slides: [{ url: 'u1', createdSec: 0 }],
    fetchImage: async () => ({ buffer: TINY_PNG, type: 'image/png' }),
  });
  const presentation = readZipEntry(buffer, 'ppt/presentation.xml');
  assert.ok(presentation, '应能从 PPTX 中读到 ppt/presentation.xml');
  const sldSz = presentation.toString().match(/<p:sldSz cx="(\d+)" cy="(\d+)"/);
  assert.ok(sldSz, 'presentation.xml 应包含 sldSz');
  const [, cx, cy] = sldSz.map(Number);
  // 旧 bug：画布 10×5.625 英寸（cx=9144000），图片框却按 13.333×7.5 摆放，播放时被裁掉约 1/3
  assert.ok(cx > 12_000_000, `画布宽度 cx=${cx} 应为宽版（>12_000_000 EMU），不能用 10 英寸默认画布`);
  assert.ok(Math.abs(cx / cy - 16 / 9) < 0.001, `画布比例 ${cx / cy} 应为 16:9`);
  // 图片框（英寸）与画布一致，整页铺满且不越界
  const placement = imagePlacement();
  assert.equal(placement.w, DECK_LAYOUT.width);
  assert.equal(placement.h, DECK_LAYOUT.height);
  assert.equal(placement.sizing.type, 'contain');
  assert.equal(Math.round(DECK_LAYOUT.width * 914400), cx, '图片框换算成 EMU 应与画布宽度一致');
  assert.equal(Math.round(DECK_LAYOUT.height * 914400), Number(cy), '图片框换算成 EMU 应与画布高度一致');
});

test('buildSessionDeck：编排时间线 + 备注 + 图片', async (t) => {
  const images = [];
  const api = {
    async fetchPptTimeline() {
      return [
        { url: 'http://img/a', createdSec: 30 },
        { url: 'http://img/a', createdSec: 35 }, // 相邻重复
        { url: 'http://img/b', createdSec: 10 },
      ];
    },
    async fetchTransResult() {
      return {
        finished: true,
        items: [
          { beginMs: 15000, text: '开场白', displayTime: '开课第00:15' },
          { beginMs: 32000, text: '翻页后的话', displayTime: '开课第00:32' },
        ],
      };
    },
    async fetchImage(url) {
      images.push(url);
      return { buffer: TINY_PNG, type: 'image/png' };
    },
  };
  const { buffer, slideCount, filename } = await buildSessionDeck({
    api,
    courseId: '1',
    subId: '2',
    courseTitle: '操作系统',
    sessionTitle: '2026-10-01 第3-4节',
  });
  assert.equal(filename, '操作系统 · 2026-10-01 第3-4节.pptx');
  assert.equal(slideCount, 2);
  assert.deepEqual(images, ['http://img/b', 'http://img/a']);
  assert.equal(buffer.subarray(0, 2).toString(), 'PK');
});

test('buildSessionDeck：时间线为空时报错；转写失败不阻塞', async () => {
  const emptyApi = {
    async fetchPptTimeline() {
      return [];
    },
  };
  await assert.rejects(() => buildSessionDeck({ api: emptyApi, courseId: '1', subId: '2' }), /没有课件/);

  const noTransApi = {
    async fetchPptTimeline() {
      return [{ url: 'u', createdSec: 0 }];
    },
    async fetchTransResult() {
      throw new Error('转写接口挂了');
    },
    async fetchImage() {
      return { buffer: TINY_PNG, type: 'image/png' };
    },
  };
  const { slideCount } = await buildSessionDeck({ api: noTransApi, courseId: '1', subId: '2' });
  assert.equal(slideCount, 1);
});

test('api.fetchPptTimeline：兼容 content 字符串/对象两种形态', async () => {
  const classroom = {
    fetch: async () => ({
      ok: true,
      json: async () => ({
        list: [
          { content: JSON.stringify({ pptimgurl: 'http://img/1' }), created_sec: '10' },
          { content: { pptimgurl: 'http://img/2' }, created_sec: 20 },
          { content: '不是JSON', created_sec: 30 },
          { content: { pptimgurl: '' }, created_sec: 40 },
        ],
      }),
    }),
  };
  const api = createApi(classroom, { requestTimeoutMs: 500 });
  const items = await api.fetchPptTimeline('1', '2');
  assert.deepEqual(items, [
    { url: 'http://img/1', createdSec: 10 },
    { url: 'http://img/2', createdSec: 20 },
  ]);
});
