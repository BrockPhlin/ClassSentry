export const DEFAULT_KEYWORDS = ["签到", "扫码", "二维码", "小测", "测验", "点名"];

export function compileKeywords(raw, defaults = DEFAULT_KEYWORDS) {
  const list = String(raw || "")
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
  const source = list.length ? list : defaults;
  return [...new Set(source.map((k) => k.toLowerCase()))];
}

export function createMatcher({ keywords, cooldownMs }) {
  const lastAlertAt = new Map();

  return {
    // 返回本片段所有"冷却已过"的命中词并刷新时间戳；无命中返回 []
    feed(fragment) {
      const text = String(fragment.text || "").toLowerCase();
      if (!text) return [];
      const now = Date.now();
      const hits = [];
      for (const keyword of keywords) {
        if (!text.includes(keyword)) continue;
        const last = lastAlertAt.get(keyword) || 0;
        if (now - last < cooldownMs) continue;
        lastAlertAt.set(keyword, now);
        hits.push(keyword);
      }
      return hits;
    },
  };
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 命中词包 ANSI 黄色高亮，返回给控制台
export function highlight(text, keywords) {
  let out = String(text);
  for (const keyword of keywords) {
    const pattern = new RegExp(escapeRegExp(keyword), "gi");
    out = out.replace(pattern, (m) => `\x1b[33m${m}\x1b[0m`);
  }
  return out;
}

// 命中词加粗（用于钉钉 markdown 正文）
export function boldKeywords(text, hits) {
  let out = String(text);
  for (const keyword of hits) {
    const pattern = new RegExp(escapeRegExp(keyword), "gi");
    out = out.replace(pattern, (m) => `**${m}**`);
  }
  return out;
}
