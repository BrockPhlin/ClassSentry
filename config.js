import "dotenv/config";

import { compileKeywords } from "./matcher.js";

export function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (["1", "true", "yes", "on"].includes(String(value).toLowerCase())) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(String(value).toLowerCase())) {
    return false;
  }
  throw new Error(`无法识别布尔值：${value}`);
}

export function buildConfig() {
  const config = {
    username: process.env.ZJU_USERNAME || "",
    password: process.env.ZJU_PASSWORD || "",
    keywords: compileKeywords(process.env.KEYWORDS),
    keywordCooldownMs: Number(process.env.KEYWORD_COOLDOWN_SECONDS || 120) * 1000,
    alertOnFinalOnly: parseBoolean(process.env.ALERT_ON_FINAL_ONLY, false),
    alertTitle: process.env.ALERT_TITLE || "【课堂预警】",
    listenMode: (process.env.LISTEN_MODE || "auto").toLowerCase(),
    pollIntervalMs: Number(process.env.POLL_INTERVAL_SECONDS || 15) * 1000,
    wsStaleTimeoutMs: Number(process.env.WS_STALE_TIMEOUT_SECONDS || 300) * 1000,
    wsReconnectMaxMs: Number(process.env.WS_RECONNECT_MAX_SECONDS || 60) * 1000,
    enableDingtalk: process.env.ENABLE_DINGTALK === "true",
    dingtalkWebhook: process.env.DINGTALK_WEBHOOK || "",
    dingtalkSecret: process.env.DINGTALK_SECRET || "",
    llmReview: parseBoolean(process.env.LLM_REVIEW, false),
    llmModel: process.env.LLM_MODEL || "claude-haiku-4-5",
    requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 20000),
    debugRaw: parseBoolean(process.env.DEBUG_RAW, false),
  };

  if (!Number.isFinite(config.keywordCooldownMs) || config.keywordCooldownMs <= 0) {
    throw new Error("KEYWORD_COOLDOWN_SECONDS 必须大于 0");
  }
  if (!["auto", "ws", "poll"].includes(config.listenMode)) {
    throw new Error("LISTEN_MODE 只能是 auto / ws / poll");
  }
  if (!Number.isFinite(config.pollIntervalMs) || config.pollIntervalMs < 3000) {
    throw new Error("POLL_INTERVAL_SECONDS 不能小于 3");
  }
  if (!Number.isFinite(config.wsStaleTimeoutMs) || config.wsStaleTimeoutMs < 30000) {
    throw new Error("WS_STALE_TIMEOUT_SECONDS 不能小于 30");
  }
  if (!Number.isFinite(config.wsReconnectMaxMs) || config.wsReconnectMaxMs <= 0) {
    throw new Error("WS_RECONNECT_MAX_SECONDS 必须大于 0");
  }
  if (!Number.isFinite(config.requestTimeoutMs) || config.requestTimeoutMs <= 0) {
    throw new Error("REQUEST_TIMEOUT_MS 必须大于 0");
  }
  return config;
}

export function ensureCredentials(config) {
  if (!config.username || !config.password) {
    throw new Error("请在 .env 中配置 ZJU_USERNAME 和 ZJU_PASSWORD");
  }
}
