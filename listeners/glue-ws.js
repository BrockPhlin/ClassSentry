import { EventEmitter } from "node:events";

import WebSocket from "ws";

// glue WebSocket 帧解析（协议逆向自智云课堂官方前端 + 真实直播帧实测校准）：
//   "pi"                      服务端心跳 ping，客户端必须回裸字符串 "po"
//   "in<socketID>"            握手回执（JSON 字符串）
//   "cd<频道名长度>&<频道名><JSON 载荷>"
//                             数据帧：如 "cd1&m{...}" = 频道 "m"（长度 1），载荷为其后整个 JSON。
//                             帧字段：sourcetext / transtext / text_begin_time / text_end_time /
//                             time / end_time（"1"=句子定稿）
// 单条 WS message 按单帧解析（glue 网关行为，ws 库保证 message 完整交付）。
// 解析失败不抛异常，返回 unknown 供日志，避免单个坏帧炸掉连接。
export function parseFrame(raw) {
  if (raw === "pi") return { type: "ping" };
  if (raw.startsWith("in")) return { type: "welcome", id: raw.slice(2) };
  if (raw.startsWith("cd")) {
    const amp = raw.indexOf("&", 2);
    if (amp === -1) return { type: "unknown", raw };
    const channelLen = Number(raw.slice(2, amp));
    if (!Number.isFinite(channelLen) || channelLen < 0) {
      return { type: "unknown", raw };
    }
    const rest = raw.slice(amp + 1);
    if (rest.length < channelLen) return { type: "unknown", raw };
    const channel = rest.slice(0, channelLen);
    const payloadText = rest.slice(channelLen);
    try {
      return { type: "data", channel, payload: JSON.parse(payloadText) };
    } catch {
      return { type: "unknown", raw };
    }
  }
  return { type: "unknown", raw };
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function formatWallClock(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const MAX_CONSECUTIVE_FAILURES = 5;

// 实时字幕 WebSocket 监听器。
// 事件：'fragment'(fragment) | 'status'(msg) | 'ended'() | 'error'(err)
//   'ended'  ：看门狗探测确认直播已结束
//   'error'  ：连续多次连接未收到数据，上层应降级到轮询
export class GlueWsListener extends EventEmitter {
  constructor({
    url,
    origin = "https://interactivemeta.cmc.zju.edu.cn",
    handshakeVersion = "1.9.1",
    staleTimeoutMs = 300000,
    reconnectMaxMs = 60000,
    debugRaw = false,
    fetchLiveState = null,
    fetchCatchUp = null,
  }) {
    super();
    this.transSocketUrl = url;
    this.url = `${url.replace(/^http/, "ws")}/glue/ws`;
    this.origin = origin;
    this.handshakeVersion = handshakeVersion;
    this.staleTimeoutMs = staleTimeoutMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.debugRaw = debugRaw;
    // fetchLiveState: () => Promise<{live}>，看门狗判断课程是否结束
    // fetchCatchUp: ({mode: "initial"|"reconnect"}) => Promise<void>，连上后补齐转写
    this.fetchLiveState = fetchLiveState;
    this.fetchCatchUp = fetchCatchUp;
    this.ws = null;
    this.stopped = false;
    this.everConnected = false;
    this.gotDataThisConnection = false;
    this.consecutiveFailures = 0;
    this.lastDataAt = Date.now();
    this.reconnectTimer = null;
    this.watchdogTimer = null;
  }

  start() {
    this.stopped = false;
    this.connect();
    this.watchdogTimer = setInterval(() => this.checkStale(), 30000);
  }

  connect() {
    if (this.stopped) return;
    this.gotDataThisConnection = false;
    this.lastDataAt = Date.now();
    this.emit("status", `连接实时字幕通道：${this.url}`);
    const ws = new WebSocket(this.url, {
      headers: { Origin: this.origin },
      handshakeTimeout: 15000,
    });
    this.ws = ws;

    ws.on("open", () => {
      ws.send("in" + JSON.stringify({ version: this.handshakeVersion }));
      this.emit("status", "已连接，等待字幕数据…");
      const mode = this.everConnected ? "reconnect" : "initial";
      this.everConnected = true;
      if (this.fetchCatchUp) {
        Promise.resolve(this.fetchCatchUp({ mode })).catch((e) => {
          this.emit("status", `补齐转写失败：${e.message}`);
        });
      }
    });
    ws.on("message", (data) => this.handleMessage(String(data)));
    // ws 库在 error 后总会触发 close，重连统一走 close
    ws.on("error", (err) => {
      this.emit("status", `连接错误：${err.message}`);
    });
    ws.on("close", () => this.scheduleReconnect());
  }

  handleMessage(raw) {
    const frame = parseFrame(raw);
    switch (frame.type) {
      case "ping":
        this.ws?.send("po");
        return;
      case "welcome":
        this.emit("status", `握手成功（socket ${frame.id}）`);
        return;
      case "data": {
        this.gotDataThisConnection = true;
        this.consecutiveFailures = 0;
        this.lastDataAt = Date.now();
        const text = String(frame.payload?.sourcetext || "").trim();
        if (!text) return;
        const beginMs =
          Number(frame.payload?.text_begin_time ?? frame.payload?.time ?? 0) ||
          Date.now();
        const endMs = Number(frame.payload?.text_end_time ?? 0) || 0;
        const final = String(frame.payload?.end_time) === "1";
        this.emit("fragment", {
          text,
          beginMs,
          endMs,
          final,
          displayTime: formatWallClock(beginMs),
          source: "ws",
          key: `w:${beginMs}|${text}`,
        });
        return;
      }
      default:
        // 协议细节逆向而来，可能存在未文档化的控制帧；DEBUG_RAW 时 dump 排障
        if (this.debugRaw) {
          console.error(`[ws 无法解析的帧] ${raw.slice(0, 500)}`);
        }
    }
  }

  scheduleReconnect() {
    this.ws = null;
    if (this.stopped) return;
    if (!this.gotDataThisConnection) {
      this.consecutiveFailures += 1;
    }
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.emit(
        "error",
        new Error(`连续 ${this.consecutiveFailures} 次连接未收到字幕数据`)
      );
      return;
    }
    const base = Math.min(
      1000 * 2 ** Math.max(this.consecutiveFailures - 1, 0),
      this.reconnectMaxMs
    );
    const delay = Math.floor(base * (0.8 + Math.random() * 0.4)); // ±20% 抖动
    this.emit(
      "status",
      `连接断开，${Math.round(delay / 1000)} 秒后重连`
    );
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  checkStale() {
    if (this.stopped) return;
    if (Date.now() - this.lastDataAt < this.staleTimeoutMs) return;
    if (!this.fetchLiveState) {
      this.emit("status", "长时间无数据，强制重连");
      this.lastDataAt = Date.now();
      this.forceReconnect();
      return;
    }
    // 防止探测期间反复触发
    this.lastDataAt = Date.now();
    this.fetchLiveState()
      .then((state) => {
        if (this.stopped) return;
        if (!state.live) {
          this.emit("ended");
          return;
        }
        // 每场课的频道哈希可能轮换，重连前刷新地址
        if (state.transSocketUrl && state.transSocketUrl !== this.transSocketUrl) {
          this.transSocketUrl = state.transSocketUrl;
          this.url = `${state.transSocketUrl.replace(/^http/, "ws")}/glue/ws`;
          this.emit("status", `字幕通道地址已刷新：${this.url}`);
        }
        this.emit("status", "连接长时间无数据但直播仍在进行，强制重连");
        this.forceReconnect();
      })
      .catch((e) => {
        this.emit("status", `探测直播状态失败：${e.message}`);
      });
  }

  forceReconnect() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // close 已触发 scheduleReconnect
      }
    } else {
      this.connect();
    }
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // 忽略
      }
      this.ws = null;
    }
  }
}
