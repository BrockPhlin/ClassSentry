import PptxGenJS from "pptxgenjs";

// 把智云的课件/板书截图时间线（api.fetchPptTimeline）+ 转写（api.fetchTransResult）
// 组装成 PPTX：每页截图一张幻灯片，该页时段内讲到的内容写入演讲者备注。

const MAX_SLIDES = 400; // 防御性上限：异常时间线不至于生成超大文件
const MIME_PREFIX = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

// 幻灯片画布（英寸，16:9 宽版）。画布与图片框必须一致：
// 此前误用 LAYOUT_16x9（10×5.625）配 13.333×7.5 的图片框，播放时图片被裁掉约 1/3。
export const DECK_LAYOUT = { name: "DECK_16x9", width: 13.333, height: 7.5 };

// 整页铺满的图片占位；contain 保证非 16:9 的板书截图完整显示（必要时留边）
export function imagePlacement() {
  return {
    x: 0,
    y: 0,
    w: DECK_LAYOUT.width,
    h: DECK_LAYOUT.height,
    sizing: { type: "contain", w: DECK_LAYOUT.width, h: DECK_LAYOUT.height },
  };
}

// 按时间排序；相邻重复 URL 去重（同一页课件在时间线里会连续出现多条）
export function dedupeTimeline(items) {
  const sorted = [...items].sort((a, b) => (a.createdSec || 0) - (b.createdSec || 0));
  const out = [];
  for (const item of sorted) {
    if (!item?.url) continue;
    if (out.length && out[out.length - 1].url === item.url) continue;
    out.push(item);
  }
  return out;
}

// 把转写行（{beginSec, text, label}）按时间窗分配到各页，作为演讲者备注文本
export function assignNotes(slides, lines) {
  const sorted = [...lines].sort((a, b) => (a.beginSec || 0) - (b.beginSec || 0));
  return slides.map((slide, i) => {
    const start = slide.createdSec || 0;
    const end = i + 1 < slides.length ? slides[i + 1].createdSec || 0 : Infinity;
    const spoken = sorted.filter((l) => l.beginSec >= start && l.beginSec < end);
    if (!spoken.length) return "";
    return spoken.map((l) => `[${l.label || ""}] ${l.text}`.replace("[] ", "[·] ")).join("\n");
  });
}

export function sanitizeFilename(s, fallback = "课堂课件") {
  const cleaned = String(s || "")
    .replace(/[\\/:*?"<>|\n\r\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || fallback).slice(0, 80);
}

// slides: [{url, createdSec, notes}]；fetchImage(url) → {buffer, type}
export async function buildDeck({ title, subtitle = "", slides, fetchImage, onProgress }) {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: DECK_LAYOUT.name, width: DECK_LAYOUT.width, height: DECK_LAYOUT.height });
  pptx.layout = DECK_LAYOUT.name;
  pptx.title = title;

  const cover = pptx.addSlide();
  cover.addText(title, { x: 0.8, y: 2.6, w: 11.7, fontSize: 36, bold: true, color: "26241D" });
  if (subtitle) {
    cover.addText(subtitle, { x: 0.8, y: 3.8, w: 11.7, fontSize: 16, color: "8B8677" });
  }

  for (let i = 0; i < slides.length; i++) {
    const { buffer, type } = await fetchImage(slides[i].url);
    const prefix = MIME_PREFIX.has(type) ? type : "image/png";
    const slide = pptx.addSlide();
    slide.addImage({
      data: `${prefix};base64,${buffer.toString("base64")}`,
      ...imagePlacement(),
    });
    if (slides[i].notes) slide.addNotes(slides[i].notes);
    onProgress?.(i + 1, slides.length);
  }

  const buffer = await pptx.write({ outputType: "nodebuffer" });
  return { buffer, slideCount: slides.length };
}

// 编排一次完整导出：时间线 → 转写备注 → 逐页下载 → PPTX
export async function buildSessionDeck({
  api,
  courseId,
  subId,
  courseTitle = "",
  sessionTitle = "",
  onProgress,
}) {
  const timeline = await api.fetchPptTimeline(courseId, subId);
  const slides = dedupeTimeline(timeline).slice(0, MAX_SLIDES);
  if (!slides.length) {
    throw new Error("该场次没有课件/板书记录");
  }

  // 转写拿不到不阻塞课件导出（备注为空而已）
  let lines = [];
  try {
    const { items } = await api.fetchTransResult(subId);
    lines = items.map((item) => ({
      beginSec: Math.round((item.beginMs || 0) / 1000),
      text: item.text,
      label: item.displayTime,
    }));
  } catch {
    // 忽略
  }

  const notes = assignNotes(slides, lines);
  const title = [courseTitle, sessionTitle].filter(Boolean).join(" · ") || "课堂课件";
  const withNotes = slides.map((s, i) => ({ ...s, notes: notes[i] }));
  const { buffer, slideCount } = await buildDeck({
    title,
    subtitle: sessionTitle,
    slides: withNotes,
    fetchImage: (url) => api.fetchImage(url),
    onProgress,
  });
  return { buffer, slideCount, filename: `${sanitizeFilename(title)}.pptx` };
}
