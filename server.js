#!/usr/bin/env node

/* Web 管理控制台入口
 *
 *   node server.js            # http://127.0.0.1:5175
 *
 * 与 CLI（index.js）共用同一套模块；监控任务运行在本进程内，服务器重启即丢失
 * （告警历史持久化在 alerts.json）。仅绑定本机回环地址，无鉴权，勿暴露公网。
 */

import "dotenv/config";

import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";

import { buildConfig } from "./config.js";
import { createCheckin } from "./checkin.js";
import { buildSessionDeck } from "./deck.js";
import { createMonitor } from "./monitor.js";
import { createNotifier } from "./notify.js";
import {
  applyToProcessEnv,
  formatEnvValue,
  restoreProcessEnv,
  toSafeSettings,
  writeEnvFile,
} from "./settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, ".env");
const HOST = process.env.WEB_HOST || "127.0.0.1";
const WEB_PORT = Number(process.env.WEB_PORT || 5175);

const monitor = createMonitor({
  getConfig: buildConfig,
  historyPath: path.join(__dirname, "alerts.json"),
});

const checkin = createCheckin({ getConfig: buildConfig });

function badRequest(message, code = "bad_request") {
  return Object.assign(new Error(message), { status: 400, code });
}

// 连通性验证结果（内存态）：由各页面共享，跨页面保持徽标一致；重启后需重新测试。
// 修改对应配置（凭据 / 钉钉参数）即失效，防止沿用过期状态。
const verified = { zhiyun: null, ding: null }; // { at, detail } | null

function markVerified(which, detail = "") {
  verified[which] = { at: Date.now(), detail };
}

function clearVerified(which) {
  verified[which] = null;
}

// /api/state 与 SSE hello 快照统一带上 verified
function withVerified(state) {
  return { ...state, verified: { ...verified } };
}

function updatesFromBody(body = {}) {
  const updates = {};
  const num = (v, key) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw badRequest(`${key} 必须是数字`);
    return String(n);
  };
  if (typeof body.zjuUsername === "string") {
    updates.ZJU_USERNAME = body.zjuUsername.trim();
  }
  if (typeof body.password === "string" && body.password !== "") {
    updates.ZJU_PASSWORD = body.password;
  }
  if (body.dingtalk && typeof body.dingtalk === "object") {
    if (typeof body.dingtalk.enabled === "boolean") {
      updates.ENABLE_DINGTALK = body.dingtalk.enabled ? "true" : "false";
    }
    if (typeof body.dingtalk.webhook === "string") {
      const webhook = body.dingtalk.webhook.trim();
      // 设置页回显的是掩码值（含 ****），原样传回说明用户没改，忽略之
      if (webhook && !webhook.includes("****")) {
        updates.DINGTALK_WEBHOOK = webhook;
      }
    }
    if (typeof body.dingtalk.secret === "string" && body.dingtalk.secret !== "") {
      updates.DINGTALK_SECRET = body.dingtalk.secret.trim();
    }
  }
  if (typeof body.keywords === "string") updates.KEYWORDS = body.keywords;
  if (body.keywordCooldownSeconds !== undefined) {
    updates.KEYWORD_COOLDOWN_SECONDS = num(body.keywordCooldownSeconds, "keywordCooldownSeconds");
  }
  if (typeof body.alertOnFinalOnly === "boolean") {
    updates.ALERT_ON_FINAL_ONLY = body.alertOnFinalOnly ? "true" : "false";
  }
  if (typeof body.alertTitle === "string") updates.ALERT_TITLE = body.alertTitle;
  if (typeof body.listenMode === "string") updates.LISTEN_MODE = body.listenMode;
  if (body.pollIntervalSeconds !== undefined) {
    updates.POLL_INTERVAL_SECONDS = num(body.pollIntervalSeconds, "pollIntervalSeconds");
  }
  if (body.wsStaleTimeoutSeconds !== undefined) {
    updates.WS_STALE_TIMEOUT_SECONDS = num(body.wsStaleTimeoutSeconds, "wsStaleTimeoutSeconds");
  }
  if (body.wsReconnectMaxSeconds !== undefined) {
    updates.WS_RECONNECT_MAX_SECONDS = num(body.wsReconnectMaxSeconds, "wsReconnectMaxSeconds");
  }
  if (body.requestTimeoutMs !== undefined) {
    updates.REQUEST_TIMEOUT_MS = num(body.requestTimeoutMs, "requestTimeoutMs");
  }
  if (typeof body.debugRaw === "boolean") {
    updates.DEBUG_RAW = body.debugRaw ? "true" : "false";
  }
  if (body.webPort !== undefined) {
    updates.WEB_PORT = num(body.webPort, "webPort");
  }
  return updates;
}

const app = express();
app.use(express.json({ limit: "200kb" }));
app.use(express.static(path.join(__dirname, "public")));

// 多页面干净地址
for (const name of ["checkin", "deck", "settings"]) {
  app.get(`/${name}`, (req, res) => {
    res.sendFile(path.join(__dirname, "public", `${name}.html`));
  });
}

app.get("/api/state", (req, res) => {
  res.json(withVerified(monitor.getState()));
});

app.get("/api/settings", (req, res) => {
  res.json(toSafeSettings(buildConfig()));
});

app.put("/api/settings", (req, res) => {
  const updates = updatesFromBody(req.body);
  if (!Object.keys(updates).length) {
    throw badRequest("没有需要保存的配置项");
  }
  // 先校验值可被 .env 安全表示（任一不合法则整体不动）
  for (const [key, value] of Object.entries(updates)) {
    try {
      formatEnvValue(value);
    } catch (e) {
      throw badRequest(`${key}：${e.message}`);
    }
  }
  // 进程内热生效 + buildConfig 校验，失败回滚
  const snapshot = applyToProcessEnv(updates);
  try {
    buildConfig();
  } catch (e) {
    restoreProcessEnv(snapshot);
    throw badRequest(e.message);
  }
  try {
    writeEnvFile(ENV_PATH, updates);
  } catch (e) {
    restoreProcessEnv(snapshot);
    throw badRequest(`写入 .env 失败：${e.message}`);
  }
  if (updates.ZJU_USERNAME !== undefined || updates.ZJU_PASSWORD !== undefined) {
    monitor.markSessionDirty();
    checkin.markSessionDirty();
    clearVerified("zhiyun");
  }
  if (
    updates.ENABLE_DINGTALK !== undefined ||
    updates.DINGTALK_WEBHOOK !== undefined ||
    updates.DINGTALK_SECRET !== undefined
  ) {
    clearVerified("ding");
  }
  res.json({
    settings: toSafeSettings(buildConfig()),
    note: "保存后对下一次监控任务生效；修改 WEB_PORT 需重启 server.js",
  });
});

app.post("/api/settings/test-ding", async (req, res) => {
  try {
    await createNotifier(buildConfig()).sendTest();
    markVerified("ding", "测试消息已发送");
    res.json({ ok: true });
  } catch (e) {
    clearVerified("ding");
    res.json({ ok: false, error: e.message });
  }
});

app.post("/api/login-test", async (req, res) => {
  try {
    const r = await monitor.loginTest();
    markVerified("zhiyun", `${r.courseCount} 门课`);
    res.json(r);
  } catch (e) {
    clearVerified("zhiyun");
    res.json({ ok: false, error: e.message });
  }
});

app.get("/api/courses", async (req, res, next) => {
  try {
    const courses = await monitor.listCourses();
    // 拉取课程成功同样证明智云连通（回访用户未手动测试过的场景）
    markVerified("zhiyun", `${courses.length} 门课`);
    res.json({ courses });
  } catch (e) {
    next(e);
  }
});

app.get("/api/courses/:id/sessions", async (req, res, next) => {
  try {
    res.json({ sessions: await monitor.listSessions(req.params.id) });
  } catch (e) {
    next(e);
  }
});

app.post("/api/probe", async (req, res, next) => {
  try {
    const { courseId, subId } = req.body || {};
    if (!courseId || !subId) throw badRequest("需要 courseId 和 subId");
    res.json(await monitor.probeSession(courseId, subId));
  } catch (e) {
    next(e);
  }
});

app.post("/api/monitor/start", async (req, res, next) => {
  try {
    const { mode, course, session, pushDingtalk } = req.body || {};
    if (!["monitor", "replay"].includes(mode)) throw badRequest("mode 必须是 monitor 或 replay");
    if (!course?.id || !session?.subId) throw badRequest("需要 course 和 session");
    const state = await monitor.start({ mode, course, session, pushDingtalk });
    res.status(202).json({ state });
  } catch (e) {
    next(e);
  }
});

app.post("/api/monitor/stop", (req, res) => {
  res.json({ state: monitor.stop() });
});

app.post("/api/monitor/reset", (req, res) => {
  res.json({ state: monitor.reset() });
});

app.post("/api/checkin/start", async (req, res, next) => {
  try {
    const state = await checkin.start();
    res.status(202).json({ state });
  } catch (e) {
    next(e);
  }
});

app.post("/api/checkin/stop", (req, res) => {
  res.json({ state: checkin.stop() });
});

app.get("/api/checkin/state", (req, res) => {
  res.json({ state: checkin.getState() });
});

// 课件/板书截图 + 转写 → PPTX 下载
app.get("/api/deck", async (req, res, next) => {
  try {
    const { courseId, subId, courseTitle, title } = req.query;
    if (!courseId || !subId) throw badRequest("需要 courseId 和 subId");
    const result = await monitor.withSession(({ api }) =>
      buildSessionDeck({
        api,
        courseId,
        subId,
        courseTitle: String(courseTitle || ""),
        sessionTitle: String(title || ""),
      })
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    );
    const asciiName = result.filename.replace(/[^\w.-]+/g, "_");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(result.filename)}`
    );
    res.send(result.buffer);
  } catch (e) {
    next(e);
  }
});

app.get("/api/alerts", (req, res) => {
  res.json({ alerts: monitor.getAlerts() });
});

app.post("/api/dev/fragment", async (req, res, next) => {
  try {
    const { text, final } = req.body || {};
    if (typeof text !== "string" || !text) throw badRequest("需要 text");
    await monitor.injectFragment({ text, final: Boolean(final) });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// SSE：连接建立后同一 tick 内先推 hello 快照再注册增量，无竞态
const sseClients = new Set();
app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 2000\n\n");
  const write = (event) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      // 连接已断
    }
  };
  write({
    type: "hello",
    payload: {
      state: withVerified(monitor.getState()),
      transcript: monitor.snapshotTranscript(),
      alerts: monitor.getAlerts(),
      checkin: checkin.getState(),
    },
  });
  const unsubscribe = monitor.subscribe(write);
  const unsubscribeCheckin = checkin.subscribe(write);
  sseClients.add(res);
  req.on("close", () => {
    unsubscribe();
    unsubscribeCheckin();
    sseClients.delete(res);
  });
});

app.use((req, res) => {
  res.status(404).json({ error: { code: "not_found", message: "接口不存在" } });
});

// 统一错误形状 {error:{code,message}}；monitor 抛出的错误自带 status/code
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) {
    console.error(`[api] ${req.method} ${req.path}:`, err);
  }
  res.status(status).json({
    error: {
      code: err.code || "internal",
      message: err.message || "内部错误",
    },
  });
});

const server = app.listen(WEB_PORT, HOST, () => {
  console.log(`Web 控制台已启动：http://${HOST}:${WEB_PORT}`);
});

setInterval(() => {
  for (const res of sseClients) {
    try {
      res.write(": ka\n\n");
    } catch {
      // 忽略
    }
  }
}, 20000).unref();

function shutdown() {
  console.log("\n正在退出…");
  try {
    monitor.stop();
  } catch {
    // 忽略
  }
  try {
    checkin.stop();
  } catch {
    // 忽略
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
