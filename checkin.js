import crypto from "node:crypto";

import { COURSES, ZJUAM } from "login-zju";

import { ensureCredentials } from "./config.js";
import { solveSphereLeastSquares } from "./geo.js";

// 学在浙大（courses.zju.edu.cn）自动点名应答，移植自 ZJU-live-better 的 courses.zju/autosign.js。
// 竞态纪律与 monitor.js 一致：epoch 守卫所有异步回调；login-zju 会话不可软重置，只能整体重建。

const API_BASE = "https://courses.zju.edu.cn";
const ROLLCALLS_URL = `${API_BASE}/api/radar/rollcalls`;
const REQUEST_TIMEOUT_MS = 20000; // 单请求超时；学在浙大挂起时不能让轮询卡死

const FAILURE_LIMIT = 15; // 连续失败轮询达到该次数即停止
const MAX_RADAR_ROUNDS = 5; // 单场雷达点名的最大尝试轮数（每轮 = 首选点 + 全部信标 + 定位估算）
const RESULTS_CAP = 100;
const BATCH_SIZE = 200; // 数字口令穷举的并发批量（原脚本实测服务端无频控）

// 校内雷达信标坐标，移植自 autosign.js 的 RadarInfo（经测试 radar_out_of_scope 限制为 500 米）
const RADAR_SITES = {
  ZJGD1: [120.089136, 30.302331], // 紫金港东一教学楼
  ZJGX1: [120.085042, 30.30173], // 紫金港西教学楼
  ZJGB1: [120.077135, 30.305142], // 紫金港段永平教学楼
  ZJG4: [120.073427, 30.299757], // 紫金港大西区
  YQ1: [120.123853, 30.262544], // 玉泉教一
  YQ4: [120.122176, 30.261555], // 玉泉教四
  YQ7: [120.120344, 30.263907], // 玉泉教七
  YQSS: [120.124001, 30.265735], // 玉泉宿舍区
  ZJ1: [120.126008, 30.192908], // 之江校区 1
  ZJ2: [120.124267, 30.19139], // 之江校区 2（校区半径不足 500m）
  HJC1: [120.195939, 30.272068], // 华家池校区 1
  HJC2: [120.198193, 30.270419], // 华家池校区 2
};
const DEFAULT_RADAR_AT = process.env.CHECKIN_RADAR_AT || "YQ1";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function sessionInvalidError(message) {
  return httpError(401, "session_invalid", message);
}

// COURSES.fetch 不会自动重登（login-zju 的登录标志一次性）；
// CAS 过期表现为重定向到 HTML 页（JSON 解析失败）或 401/403，这里统一归类为可重登错误。
function isSessionInvalidError(err) {
  return err?.code === "session_invalid";
}

export function createCheckin({
  getConfig,
  coursesFactory = (cfg) => new COURSES(new ZJUAM(cfg.username, cfg.password)),
  pollMs = 4000,
  idleStopMs = 15 * 60 * 1000,
}) {
  // phase: idle -> starting -> running -> (stopped | error)；stopped/error 可重新 start
  let phase = "idle";
  let startedAt = null;
  let stoppedAt = null;
  let stopReason = null;
  let lastError = null;
  let epoch = 0;
  let stats = emptyStats();
  let attemptedIds = new Set();
  let radarRounds = new Map();
  let pending = new Map(); // rollcallId -> 进行中的应答链，防 4s 轮询双发
  const results = []; // 每场点名一条，最新在前
  let lastActiveAt = 0;

  const sessionRef = { courses: null };
  let sessionDirty = true;

  const subscribers = new Set();

  function emptyStats() {
    return { seen: 0, answered: 0, failed: 0 };
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
    broadcast("checkin", getState());
  }

  function getState() {
    return {
      phase,
      startedAt,
      stoppedAt,
      stopReason,
      lastError,
      stats: { ...stats, active: pending.size },
      idleStopMs,
      results: results.map((r) => ({ ...r })),
    };
  }

  async function ensureSession({ force = false } = {}) {
    if (!force && !sessionDirty && sessionRef.courses) return sessionRef.courses;
    const cfg = getConfig();
    ensureCredentials(cfg);
    sessionRef.courses = coursesFactory(cfg);
    sessionDirty = false;
    return sessionRef.courses;
  }

  function markSessionDirty() {
    sessionDirty = true;
  }

  // 会话失效时重建一次再试；仍失败则抛出
  async function withRelogin(fn) {
    const courses = await ensureSession();
    try {
      return await fn(courses);
    } catch (e) {
      if (!isSessionInvalidError(e)) throw e;
      console.log("[checkin] 学在浙大会话失效，重新登录…");
      const fresh = await ensureSession({ force: true });
      return fn(fresh);
    }
  }

  async function apiJson(courses, url, opts = {}) {
    const res = await courses.fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...opts });
    if (res.status === 401 || res.status === 403) {
      throw sessionInvalidError("学在浙大登录已失效");
    }
    try {
      return await res.json();
    } catch {
      throw sessionInvalidError("学在浙大会话已失效（返回了非 JSON 内容）");
    }
  }

  function upsertResult(entry) {
    const idx = results.findIndex((r) => r.rollcallId === entry.rollcallId);
    if (idx >= 0) results[idx] = entry;
    else {
      results.unshift(entry);
      if (results.length > RESULTS_CAP) results.pop();
    }
    return entry;
  }

  // 终态落账：调用方负责 epoch 守卫与广播
  function finishEntry(entry, outcome, detail) {
    entry.outcome = outcome;
    entry.detail = detail || "";
    entry.at = Date.now();
    if (outcome === "success") stats.answered += 1;
    else stats.failed += 1;
  }

  function isOnCall(rc) {
    return (
      rc.status === "on_call" ||
      rc.status === "on_call_fine" ||
      rc.status_name === "on_call" ||
      rc.status_name === "on_call_fine"
    );
  }

  async function pollOnce(myEpoch) {
    const data = await withRelogin((courses) => apiJson(courses, ROLLCALLS_URL));
    if (myEpoch !== epoch) return;
    const rollcalls = Array.isArray(data?.rollcalls) ? data.rollcalls : [];
    const active = rollcalls.filter(
      (rc) => !rc.is_expired && rc.rollcall_status === "in_progress"
    );
    if (active.length > 0) lastActiveAt = Date.now();

    for (const rc of active) {
      const id = rc.rollcall_id;
      if (id == null || attemptedIds.has(id) || pending.has(id)) continue;
      if (isOnCall(rc)) {
        attemptedIds.add(id); // 已在签到处，静默记录，不进结果表
        continue;
      }

      const kind = rc.is_radar ? "radar" : rc.is_number ? "number" : "unknown";
      stats.seen += 1;
      const entry = upsertResult({
        rollcallId: id,
        at: Date.now(),
        kind,
        courseTitle: rc.course_title || "",
        title: rc.title || "",
        outcome: "attempting",
        detail: "",
      });

      if (kind === "unknown") {
        finishEntry(entry, "unsupported", "暂不支持的点名类型");
        continue;
      }

      const chain = (kind === "radar" ? answerRadar(id, entry, myEpoch) : answerNumber(id, entry, myEpoch))
        .catch((e) => {
          if (myEpoch !== epoch) return;
          finishEntry(entry, "failed", String(e.message || e));
          broadcastState();
        })
        .finally(() => pending.delete(id));
      pending.set(id, chain);
    }
    broadcastState();
  }

  async function submitRadar(myEpoch, id, lon, lat) {
    return withRelogin((courses) =>
      apiJson(courses, `${API_BASE}/api/rollcall/${id}/answer?api_version=1.1.2`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: crypto.randomUUID(),
          latitude: lat,
          longitude: lon,
          speed: null,
          accuracy: 68,
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
        }),
      })
    );
  }

  function extractDistance(outcome) {
    const d = Number(
      outcome?.distance ?? outcome?.data?.distance ?? outcome?.result?.distance
    );
    return Number.isFinite(d) && d > 0 ? d : null;
  }

  async function answerRadar(id, entry, myEpoch) {
    const succeeded = (outcome) => outcome?.status_name === "on_call_fine";

    // 首选配置点位，再遍历全部信标（去重），收集失败返回的 distance
    const tried = [];
    const queue = [];
    for (const [key, coord] of Object.entries(RADAR_SITES)) {
      if (key === DEFAULT_RADAR_AT) queue.unshift([key, coord]);
      else queue.push([key, coord]);
    }

    for (const [key, [lon, lat]] of queue) {
      const outcome = await submitRadar(myEpoch, id, lon, lat);
      if (myEpoch !== epoch) return;
      if (succeeded(outcome)) {
        finishEntry(entry, "success", key);
        broadcastState();
        attemptedIds.add(id);
        return;
      }
      tried.push({ key, lon, lat, d: extractDistance(outcome) });
    }

    // ≥3 个有效距离时做球面最小二乘定位，再按估算坐标提交
    const points = tried.filter((p) => p.d != null);
    if (points.length >= 3) {
      const est = solveSphereLeastSquares(points);
      if (Number.isFinite(est.lon) && Number.isFinite(est.lat)) {
        const outcome = await submitRadar(myEpoch, id, est.lon, est.lat);
        if (myEpoch !== epoch) return;
        if (succeeded(outcome)) {
          finishEntry(entry, "success", `估算坐标 ${est.lon.toFixed(5)}, ${est.lat.toFixed(5)}`);
          broadcastState();
          attemptedIds.add(id);
          return;
        }
      }
    }

    // 整轮失败：计入轮次，超过上限才判终态，否则留待下一轮询重试
    const rounds = (radarRounds.get(id) || 0) + 1;
    radarRounds.set(id, rounds);
    if (rounds >= MAX_RADAR_ROUNDS) {
      attemptedIds.add(id);
      finishEntry(entry, "failed", `${rounds} 轮定位均未成功`);
      broadcastState();
    }
  }

  async function submitNumber(myEpoch, id, numberCode) {
    return withRelogin((courses) =>
      apiJson(courses, `${API_BASE}/api/rollcall/${id}/answer_number_rollcall`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: crypto.randomUUID(), numberCode }),
      })
    );
  }

  async function answerNumber(id, entry, myEpoch) {
    const isWrong = (outcome) => Boolean(outcome?.error_code);

    // 先从接口直接拿口令试一次（原脚本行为），拿不到或不对再穷举
    let directCode = null;
    try {
      const data = await withRelogin((courses) =>
        apiJson(courses, `${API_BASE}/api/rollcall/${id}/student_rollcalls`)
      );
      if (myEpoch !== epoch) return;
      const code = data?.number_code;
      if (typeof code === "string" && /^\d{4}$/.test(code)) directCode = code;
    } catch {
      // 拿不到口令不影响穷举
    }

    if (directCode) {
      const outcome = await submitNumber(myEpoch, id, directCode);
      if (myEpoch !== epoch) return;
      if (!isWrong(outcome)) {
        finishEntry(entry, "success", `口令 ${directCode}`);
        broadcastState();
        attemptedIds.add(id);
        return;
      }
    }

    // 穷举 0000-9999，批量并发，首个成功即提前收兵
    let foundCode = null;
    let foundResolve;
    const foundPromise = new Promise((resolve) => {
      foundResolve = resolve;
    });
    const noteSuccess = (code) => {
      if (foundCode == null) {
        foundCode = code;
        foundResolve();
      }
    };

    for (let start = 0; start <= 9999 && foundCode == null; start += BATCH_SIZE) {
      if (myEpoch !== epoch) return;
      const end = Math.min(start + BATCH_SIZE - 1, 9999);
      const tasks = [];
      for (let ckn = start; ckn <= end; ckn++) {
        const code = String(ckn).padStart(4, "0");
        tasks.push(
          submitNumber(myEpoch, id, code)
            .then((outcome) => {
              if (!isWrong(outcome)) noteSuccess(code);
            })
            .catch(() => {
              // 单个提交失败继续穷举
            })
        );
      }
      await Promise.race([Promise.all(tasks), foundPromise]);
    }

    if (myEpoch !== epoch) return;
    attemptedIds.add(id); // 每场点名每次会话只完整扫一遍
    if (foundCode == null) {
      finishEntry(entry, "failed", "未找到有效口令");
    } else {
      finishEntry(entry, "success", `口令 ${foundCode}`);
    }
    broadcastState();
  }

  async function pollLoop(myEpoch) {
    let failStreak = 0;
    while (myEpoch === epoch && phase === "running") {
      const t0 = Date.now();
      try {
        await pollOnce(myEpoch);
        if (myEpoch !== epoch) return;
        failStreak = 0;
      } catch (e) {
        if (myEpoch !== epoch) return;
        failStreak += 1;
        lastError = String(e.message || e);
        broadcastState();
        if (failStreak >= FAILURE_LIMIT) {
          stop("errors");
          return;
        }
      }
      if (Date.now() - lastActiveAt >= idleStopMs) {
        stop("idle");
        return;
      }
      await sleep(Math.max(0, pollMs - (Date.now() - t0)));
    }
  }

  async function start() {
    if (phase === "starting" || phase === "running") {
      throw httpError(409, "already_running", "签到模式已在运行");
    }
    try {
      ensureCredentials(getConfig());
    } catch (e) {
      throw httpError(400, "no_credentials", e.message);
    }

    const myEpoch = ++epoch;
    phase = "starting";
    startedAt = null;
    stoppedAt = null;
    stopReason = null;
    lastError = null;
    stats = emptyStats();
    attemptedIds = new Set();
    radarRounds = new Map();
    pending = new Map();
    results.length = 0;
    lastActiveAt = Date.now();
    broadcastState();

    try {
      await ensureSession({ force: sessionDirty });
      if (myEpoch !== epoch) return getState();
      // 首轮立即执行，凭据错误在 starting 阶段就地失败
      await pollOnce(myEpoch);
      if (myEpoch !== epoch) return getState();
      phase = "running";
      startedAt = Date.now();
      broadcastState();
      pollLoop(myEpoch).catch(() => {});
      return getState();
    } catch (e) {
      if (myEpoch !== epoch) return getState();
      epoch += 1;
      phase = "error";
      stoppedAt = Date.now();
      lastError = String(e.message || e);
      broadcastState();
      throw e;
    }
  }

  function stop(reason = "manual") {
    epoch += 1;
    pending.clear();
    if (phase === "starting" || phase === "running") {
      phase = "stopped";
      stoppedAt = Date.now();
      stopReason = reason;
      console.log(`[checkin] 签到模式已停止（${reason}）`);
    }
    broadcastState();
    return getState();
  }

  return {
    getState,
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    markSessionDirty,
    start,
    stop,
  };
}
