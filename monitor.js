import fs from "node:fs";

import { CLASSROOM, ZJUAM } from "login-zju";

import { createApi, SESSION_STATUS } from "./api.js";
import { createSessionListener } from "./listen.js";
import { PollListener } from "./listeners/poll.js";
import { createPipeline } from "./pipeline.js";

const TRANSCRIPT_CAP = 500;
const ALERTS_CAP = 500;
const RELOGIN_THROTTLE_MS = 60000;

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function isSessionInvalidError(err) {
  const msg = String(err?.message || "");
  return msg.includes("登录可能已失效") || /HTTP 40[13]/.test(msg);
}

// 服务器进程内监控任务状态机：同一时间至多一个任务。
// phase: idle -> starting -> running -> (ended | stopped | error)；ended/stopped/error 可重新 start。
export function createMonitor({ getConfig, historyPath, apiFactory = createApi }) {
  let phase = "idle";
  let mode = null; // "monitor" | "replay"
  let course = null;
  let session = null;
  let probe = null;
  let listenerCtl = null;
  let pipeline = null;
  let taskConfig = null;
  let startedAt = null;
  let endedAt = null;
  let lastError = null;
  let epoch = 0;

  // login-zju 会话无法软重置（内部登录标志私有且不可逆），重登 = 整体重建
  const sessionRef = { classroom: null, api: null, current: null };
  let sessionDirty = true;
  let reloginAt = 0;
  let reloginPromise = null;

  const subscribers = new Set();
  const transcriptBuf = [];
  let alerts = loadAlerts();

  function loadAlerts() {
    try {
      const parsed = JSON.parse(fs.readFileSync(historyPath, "utf8"));
      return Array.isArray(parsed?.alerts) ? parsed.alerts.slice(0, ALERTS_CAP) : [];
    } catch {
      return [];
    }
  }

  function persistAlerts() {
    try {
      const tmp = `${historyPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ alerts }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, historyPath);
    } catch (e) {
      console.error(`告警历史写入失败：${e.message}`);
    }
  }

  function broadcast(type, payload) {
    for (const fn of subscribers) {
      try {
        fn({ type, payload });
      } catch {
        // 单个客户端写入失败不影响其他
      }
    }
  }

  function broadcastState() {
    broadcast("state", getState());
  }

  async function ensureSession({ force = false } = {}) {
    if (!force && !sessionDirty && sessionRef.api) return sessionRef;
    const cfg = getConfig();
    const classroom = new CLASSROOM(new ZJUAM(cfg.username, cfg.password));
    sessionRef.classroom = classroom;
    sessionRef.api = apiFactory(classroom, cfg);
    sessionRef.current = sessionRef.api;
    sessionDirty = false;
    return sessionRef;
  }

  function triggerRelogin() {
    const now = Date.now();
    if (reloginPromise) return reloginPromise;
    if (now - reloginAt < RELOGIN_THROTTLE_MS) return Promise.resolve();
    reloginAt = now;
    reloginPromise = ensureSession({ force: true })
      .then(() => {
        log("会话失效，已重新登录", "info");
      })
      .catch((e) => {
        log(`重新登录失败：${e.message}，可在设置页更新凭据后重试`, "error");
      })
      .finally(() => {
        reloginPromise = null;
      });
    return reloginPromise;
  }

  function log(msg, level = "info") {
    broadcast("status", { msg, level, at: Date.now() });
    if (level === "error" && /登录可能已失效|HTTP 40[13]/.test(msg)) {
      triggerRelogin();
    }
  }

  // 交给 pipeline 的 Web 渲染 sink：广播事件 + 喂环形缓冲
  function makeSink() {
    return {
      fragment(fragment) {
        const entry = {
          text: fragment.text,
          displayTime: fragment.displayTime,
          final: Boolean(fragment.final),
          at: Date.now(),
        };
        transcriptBuf.push(entry);
        if (transcriptBuf.length > TRANSCRIPT_CAP) transcriptBuf.shift();
        broadcast("fragment", {
          text: entry.text,
          displayTime: entry.displayTime,
          final: entry.final,
        });
      },
      endInterim() {
        const last = transcriptBuf.at(-1);
        if (last && !last.final) last.flushed = true;
        broadcast("transcript_flush", {});
      },
      alert() {
        // 命中详情由 context.onAlert 以 alert 事件下发，这里无需重复
      },
      notice(text) {
        log(text, "warn");
      },
    };
  }

  function getState() {
    const cfg = getConfig();
    return {
      phase,
      mode,
      course,
      session,
      probe: probe
        ? {
            live: probe.live,
            subStatus: probe.subStatus,
            hasAsr: probe.hasAsr,
            asrRunning: probe.asrRunning,
          }
        : null,
      listenerKind: listenerCtl?.kind ?? null,
      degraded: listenerCtl?.degraded ?? false,
      startedAt,
      endedAt,
      lastError,
      stats: pipeline
        ? { ...pipeline.stats }
        : { fragments: 0, alerts: 0 },
      config: {
        enableDingtalk: cfg.enableDingtalk,
        listenMode: cfg.listenMode,
        pollIntervalSeconds: cfg.pollIntervalMs / 1000,
        alertOnFinalOnly: cfg.alertOnFinalOnly,
        alertTitle: cfg.alertTitle,
        keywords: taskConfig?.keywords ?? cfg.keywords,
      },
    };
  }

  // 带一次重登重试的 API 调用
  async function withRelogin(fn) {
    await ensureSession();
    try {
      return await fn();
    } catch (e) {
      if (!isSessionInvalidError(e)) throw e;
      await ensureSession({ force: true });
      log("会话失效，已重新登录", "info");
      return fn();
    }
  }

  return {
    getState,
    snapshotTranscript() {
      return [...transcriptBuf];
    },
    getAlerts() {
      return [...alerts];
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    markSessionDirty() {
      sessionDirty = true;
    },

    async listCourses() {
      return withRelogin(() => sessionRef.api.listCourses());
    },

    async listSessions(courseId) {
      const rows = await withRelogin(() => sessionRef.api.listCatalogue(courseId));
      return rows.map((s) => ({
        subId: s.sub_id,
        title: s.title,
        status: String(s.status),
        statusText: SESSION_STATUS[String(s.status)] || `状态${s.status}`,
        startAtMs: Number(s.start_at) * 1000,
        startLabel: new Date(Number(s.start_at) * 1000).toLocaleString("zh-CN", {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }),
      }));
    },

    async probeSession(courseId, subId) {
      const result = await withRelogin(() =>
        sessionRef.api.searchLive(courseId, subId)
      );
      return {
        live: result.live,
        subStatus: result.subStatus,
        hasAsr: result.hasAsr,
        asrRunning: result.asrRunning,
      };
    },

    // 总是用当前设置重建会话并装回 monitor（改凭据后的验证入口）
    async loginTest() {
      const started = Date.now();
      await ensureSession({ force: true });
      const courses = await sessionRef.api.listCourses();
      return { ok: true, courseCount: courses.length, elapsedMs: Date.now() - started };
    },

    async start({ mode: taskMode, course: c, session: s, pushDingtalk }) {
      if (phase === "starting" || phase === "running") {
        throw httpError(409, "already_running", "已有监控任务在运行，请先停止");
      }
      const cfg = getConfig();
      if (taskMode === "replay" && cfg.enableDingtalk && pushDingtalk !== true) {
        throw httpError(
          400,
          "confirm_required",
          "重放会按历史转写真实推送钉钉，需要显式确认"
        );
      }

      taskConfig = cfg;
      pipeline = null;
      probe = null;
      phase = "starting";
      mode = taskMode;
      course = { id: c.id, title: c.title, teacher: c.teacher || "" };
      session = {
        subId: s.sub_id ?? s.subId,
        title: s.title,
        status: s.status ?? null,
        startAtMs:
          s.startAtMs != null
            ? Number(s.startAtMs)
            : Number(s.start_at ?? 0) * 1000,
      };
      startedAt = null;
      endedAt = null;
      lastError = null;
      broadcastState();

      const myEpoch = ++epoch;
      try {
        await ensureSession({ force: sessionDirty });
        if (myEpoch !== epoch) return getState();

        // 探测失败沿用 CLI 语义：warn 后按无通道继续（走轮询）
        let pr = { live: false, hasAsr: false, asrRunning: false, transSocketUrl: "" };
        try {
          pr = await sessionRef.api.searchLive(course.id, session.subId);
        } catch (e) {
          log(`探测直播状态失败：${e.message}`, "warn");
        }
        if (myEpoch !== epoch) return getState();
        probe = pr;

        const courseLabel = course.teacher
          ? `${course.title}（${course.teacher}）`
          : course.title;
        const basePipeline = createPipeline(
          cfg,
          {
            courseLabel,
            sessionTitle: session.title,
            onAlert: ({ fragment, hits, sent, reason, at }) => {
              if (myEpoch !== epoch) return;
              const entry = {
                id: `${at}-${hits.join("/")}`,
                at,
                displayTime: fragment.displayTime,
                hits,
                sentence: fragment.text,
                sent,
                reason,
                mode: taskMode,
                courseLabel,
                sessionTitle: session.title,
              };
              alerts.unshift(entry);
              if (alerts.length > ALERTS_CAP) alerts.length = ALERTS_CAP;
              persistAlerts();
              broadcast("alert", entry);
            },
          },
          makeSink()
        );
        pipeline = {
          async ingest(fragment, opts) {
            if (myEpoch !== epoch) return; // stop 后丢弃 in-flight
            await basePipeline.ingest(fragment, opts);
            if (myEpoch === epoch) broadcastState();
          },
          newlineIfInterim: () => basePipeline.newlineIfInterim(),
          stats: basePipeline.stats,
        };

        const handleEnded = (label) => () => {
          if (myEpoch !== epoch) return;
          listenerCtl?.stop();
          pipeline?.newlineIfInterim();
          phase = "ended";
          endedAt = Date.now();
          log(label, "info");
          broadcastState();
        };

        if (taskMode === "replay") {
          // 重放：不走 WS，直接轮询一次历史转写，全部视为新条目
          const listener = new PollListener({
            fetchItems: () =>
              sessionRef.api.fetchTransResult(session.subId, {
                sessionStartMs: session.startAtMs,
                source: "replay",
              }),
            intervalMs: cfg.pollIntervalMs,
            alertOnBaseline: true,
          });
          listener.on("fragment", (fragment) => {
            pipeline.ingest(fragment).catch((e) => {
              log(`处理转写失败：${e.message}`, "error");
            });
          });
          listener.on("status", (msg) => log(msg, "info"));
          listener.on("error", (err) => log(err.message, "error"));
          listener.on("ended", handleEnded("重放结束"));
          listenerCtl = {
            start: () => listener.start(),
            stop: () => listener.stop(),
            kind: "poll",
            degraded: false,
          };
        } else {
          listenerCtl = createSessionListener({
            config: cfg,
            apiRef: sessionRef, // 重登后 current 被替换，工厂闭包自动用新 api
            course,
            session: { ...session, start_at: session.startAtMs / 1000 },
            probe,
            pipeline,
            log,
            onEnded: handleEnded("本场直播结束"),
            onDegraded: () => broadcastState(),
          });
        }

        phase = "running";
        startedAt = Date.now();
        listenerCtl.start();
        broadcastState();
        return getState();
      } catch (e) {
        if (myEpoch !== epoch) return getState();
        listenerCtl?.stop();
        listenerCtl = null;
        epoch++;
        phase = "error";
        lastError = String(e.message || e);
        broadcastState();
        throw e;
      }
    },

    stop() {
      listenerCtl?.stop();
      pipeline?.newlineIfInterim();
      listenerCtl = null;
      if (phase === "starting" || phase === "running") {
        epoch++;
        phase = "stopped";
        endedAt = Date.now();
        log("任务已停止", "info");
      }
      broadcastState();
      return getState();
    },

    reset() {
      if (phase === "starting" || phase === "running") {
        throw httpError(409, "already_running", "任务运行中，请先停止");
      }
      epoch++; // 清除后丢弃上一场尚未完成的处理回调
      transcriptBuf.length = 0;
      phase = "idle";
      mode = null;
      course = null;
      session = null;
      probe = null;
      listenerCtl = null;
      pipeline = null;
      taskConfig = null;
      startedAt = null;
      endedAt = null;
      lastError = null;
      broadcastState();
      return getState();
    },

    // WEB_DEV_TOOLS=1 时的人工注入入口：走完整 ingest 管道（去重/匹配/告警）
    async injectFragment({ text, final }) {
      if (process.env.WEB_DEV_TOOLS !== "1") {
        throw httpError(404, "not_found", "未开启 WEB_DEV_TOOLS");
      }
      if (phase !== "running" || !pipeline) {
        throw httpError(409, "not_running", "当前没有运行中的监控任务");
      }
      const now = Date.now();
      const d = new Date(now);
      const pad = (n) => String(n).padStart(2, "0");
      await pipeline.ingest({
        text: String(text || ""),
        beginMs: now,
        endMs: 0,
        final: Boolean(final),
        displayTime: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
        source: "dev",
        key: `dev:${now}|${text}`,
      });
    },
  };
}
