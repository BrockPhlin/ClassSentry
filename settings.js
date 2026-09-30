import fs from "node:fs";
import path from "node:path";

// .env 文本读写：只接管 MANAGED_KEYS，其余行（注释、PINTIA_COOKIE、GRADE_* 等）原样保留。
// quoting 规则依据 dotenv 16 的 LINE 正则实测语义：
//   - 裸值遇 "#" 即截断（无需空格）；裸值会被 trim
//   - 双引号值内 \n/\r 会被展开，\" 不会反转义
//   - 单引号值内不做任何展开
export const MANAGED_KEYS = [
  "ZJU_USERNAME",
  "ZJU_PASSWORD",
  "ENABLE_DINGTALK",
  "DINGTALK_WEBHOOK",
  "DINGTALK_SECRET",
  "KEYWORDS",
  "KEYWORD_COOLDOWN_SECONDS",
  "ALERT_ON_FINAL_ONLY",
  "ALERT_TITLE",
  "LISTEN_MODE",
  "POLL_INTERVAL_SECONDS",
  "WS_STALE_TIMEOUT_SECONDS",
  "WS_RECONNECT_MAX_SECONDS",
  "REQUEST_TIMEOUT_MS",
  "DEBUG_RAW",
  "WEB_PORT",
];

const KEY_LINE = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.-]*)(\s*=\s*)(.*)$/;

// 把一行（不含行尾换行符）拆成 {prefix, key, eq, valueToken, comment}；非键值行返回 null。
// comment 含 "#" 起的内联注释；无法确定 valueToken 边界的行（跨行/未闭合引号）valueToken=null。
export function splitEnvLine(line) {
  const m = line.match(KEY_LINE);
  if (!m) return null;
  const [, prefix, key, eq, rest] = m;
  if (rest.startsWith("'") || rest.startsWith('"')) {
    const quote = rest[0];
    let end = -1;
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === "\\" && quote === '"' && i + 1 < rest.length) {
        i++; // 跳过双引号内的 \" 转义
        continue;
      }
      if (rest[i] === quote) {
        end = i;
        break;
      }
    }
    if (end === -1) return { prefix, key, eq, valueToken: null, comment: "" };
    const after = rest.slice(end + 1);
    if (after.trim() !== "" && !after.trim().startsWith("#")) {
      // 引号后跟了其他内容，dotenv 不会解析这行，视为不可改写
      return { prefix, key, eq, valueToken: null, comment: "" };
    }
    return {
      prefix,
      key,
      eq,
      valueToken: rest.slice(0, end + 1),
      comment: after,
    };
  }
  const hash = rest.indexOf("#");
  const rawValue = hash === -1 ? rest : rest.slice(0, hash);
  const trimmed = rawValue.trim();
  // 值与 "#" 之间的空白归入 comment，重写时原样恢复（ENABLE_DINGTALK=true # ...）
  const gap = rawValue.slice(trimmed.length);
  return {
    prefix,
    key,
    eq,
    valueToken: trimmed,
    comment: gap + (hash === -1 ? "" : rest.slice(hash)),
  };
}

// 依据 dotenv 语义为值生成安全的 token；两种引号并存时抛错（无法表示）
export function formatEnvValue(value) {
  const v = String(value);
  if (v === "") return "";
  if (!/[#'"\n\r]/.test(v) && v.trim() === v) return v;
  if (!v.includes("'")) return `'${v}'`;
  if (!v.includes('"')) {
    return `"${v.replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
  }
  throw new Error("值不能同时包含单引号和双引号");
}

// 纯函数：返回更新后的 .env 文本。
// updates: {ENV_KEY: "字符串值"}。只重写 managed key 的 valueToken（最后一处），
// 保留 prefix/等号两侧空白/内联注释/其余所有行；缺失键追加到末尾；
// 无法解析的已有 managed 行不动，改为尾部追加修正行（dotenv 后值生效）。
export function renderEnvUpdate(text, updates) {
  const keys = Object.keys(updates);
  if (!keys.length) return text;
  for (const key of keys) {
    if (!MANAGED_KEYS.includes(key)) {
      throw new Error(`非托管键：${key}`);
    }
    formatEnvValue(updates[key]); // 提前校验，任一值不合法则整体不动
  }

  const useCrlf = text.includes("\r\n");
  const parts = text.split(/(?<=\n)/); // 保留每行自带换行符
  const pending = new Map(Object.entries(updates));
  const fixups = [];

  for (let i = 0; i < parts.length; i++) {
    const body = parts[i].replace(/(\r?\n)$/, "");
    const parsed = splitEnvLine(body);
    if (!parsed || !pending.has(parsed.key)) continue;
    fixups.push({ ...parsed, index: i });
  }
  // 重复键只改最后一处（Map 后写覆盖 = 最后一次出现）
  const lastByKey = new Map();
  for (const f of fixups) lastByKey.set(f.key, f);
  for (const f of fixups) {
    if (lastByKey.get(f.key) !== f) continue;
    const token = formatEnvValue(pending.get(f.key));
    if (f.valueToken === null) continue; // 无法解析的行不动，靠尾部追加
    const eol =
      parts[f.index].match(/(\r?\n)$/)?.[1] || (useCrlf ? "\r\n" : "\n");
    parts[f.index] = f.prefix + f.key + f.eq + token + f.comment + eol;
    pending.delete(f.key);
  }

  if (pending.size) {
    const needsBlank = parts.length && parts[parts.length - 1].trim() !== "";
    const lines = [];
    if (needsBlank) lines.push(useCrlf ? "\r\n" : "\n");
    lines.push(`${useCrlf ? "\r\n" : "\n"}# ===== 由 Web 控制台补充 =====${useCrlf ? "\r\n" : "\n"}`);
    for (const key of MANAGED_KEYS) {
      if (!pending.has(key)) continue;
      lines.push(
        `${key}=${formatEnvValue(pending.get(key))}${useCrlf ? "\r\n" : "\n"}`
      );
      pending.delete(key);
    }
    parts.push(...lines);
  }
  return parts.join("");
}

// 原子写 .env；返回本次实际写入的 updates（供调用方做 process.env 同步/回滚）
export function writeEnvFile(envPath, updates) {
  const text = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const rendered = renderEnvUpdate(text, updates);
  const tmp = `${envPath}.tmp`;
  fs.writeFileSync(tmp, rendered, { mode: 0o600 });
  fs.renameSync(tmp, envPath);
  return { ...updates };
}

// 仅合并 MANAGED_KEYS 到 process.env（缺省值显式置 ""，防止旧值残留）。
// 不能用 dotenv.config()：它默认不覆盖已存在的变量，热更新会静默失效。
// 返回合并前快照供回滚。
export function applyToProcessEnv(updates) {
  const snapshot = {};
  for (const key of MANAGED_KEYS) {
    if (!(key in updates)) continue;
    snapshot[key] = process.env[key];
    process.env[key] = String(updates[key]);
  }
  return snapshot;
}

export function restoreProcessEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function maskSecret(v) {
  if (!v) return "";
  if (v.length <= 8) return "*".repeat(v.length);
  return `${v.slice(0, 4)}${"*".repeat(6)}${v.slice(-4)}`;
}

function maskWebhook(v) {
  if (!v) return "";
  try {
    const url = new URL(v);
    // 不返回任何查询参数或 URL 中的凭据，包括短 token。
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, "****");
    url.hash = "";
    return url.toString();
  } catch {
    return "****";
  }
}

// GET /api/settings 的安全视图：密码/secret 永不回显
export function toSafeSettings(config) {
  return {
    zjuUsername: config.username,
    hasPassword: Boolean(config.password),
    dingtalk: {
      enabled: config.enableDingtalk,
      webhook: maskWebhook(config.dingtalkWebhook),
      hasSecret: Boolean(config.dingtalkSecret),
    },
    keywords: config.keywords.join(","),
    keywordCooldownSeconds: config.keywordCooldownMs / 1000,
    alertOnFinalOnly: config.alertOnFinalOnly,
    alertTitle: config.alertTitle,
    listenMode: config.listenMode,
    pollIntervalSeconds: config.pollIntervalMs / 1000,
    wsStaleTimeoutSeconds: config.wsStaleTimeoutMs / 1000,
    wsReconnectMaxSeconds: config.wsReconnectMaxMs / 1000,
    requestTimeoutMs: config.requestTimeoutMs,
    debugRaw: config.debugRaw,
    webPort: Number(process.env.WEB_PORT || 5175),
  };
}
