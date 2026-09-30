import { GlueWsListener } from "./listeners/glue-ws.js";
import { PollListener } from "./listeners/poll.js";

// 共享监听器工厂：CLI（index.js）与 Web（monitor.js）共用的
// "探测结果 -> WS/轮询选择 + 断线降级" 逻辑，避免两处复制。
//
// apiRef: { current: api } —— 所有闭包经它取用 api，支持热重登
// （monitor 重登后替换 current 即对进行中的任务生效）。
// log(msg, level="info"|"warn"|"error")
// onEnded()：直播结束（WS 看门狗判定 / 轮询探到课后形态）。
// onDegraded()：WS 降级到轮询后回调（Web 用于刷新 kind/degraded 状态）。
//
// 返回 { start(), stop(), get kind(): "ws"|"poll", get degraded(): boolean }
export function createSessionListener({
  config,
  apiRef,
  course,
  session,
  probe,
  pipeline,
  log,
  onEnded,
  onDegraded,
}) {
  // 兼容两种 session 形态：CLI 传原始目录条目（sub_id/start_at 秒），
  // Web 传归一化对象（subId/startAtMs 毫秒）
  const subId = session.sub_id ?? session.subId;
  const sessionStartSec = Number(session.start_at ?? session.startAtMs / 1000 ?? 0);
  const courseId = session.course_id ?? course.id;
  const fetchItems = () =>
    apiRef.current.fetchTransResult(subId, {
      sessionStartMs: sessionStartSec * 1000,
      source: "poll",
    });

  let current = null;
  let kind = null;
  let degraded = false;
  let stopped = false;

  function wire(listener) {
    listener.on("fragment", (fragment) => {
      pipeline.ingest(fragment).catch((e) => {
        log(`处理转写失败：${e.message}`, "error");
      });
    });
    listener.on("status", (msg) => log(msg, "info"));
    if (onEnded) listener.on("ended", onEnded);
    return listener;
  }

  function buildPoll() {
    const listener = wire(
      new PollListener({
        fetchItems,
        intervalMs: config.pollIntervalMs,
        alertOnBaseline: false,
      })
    );
    // 连续轮询失败：打印但任务继续（与 CLI 行为一致），重登由上层按错误模式处理
    listener.on("error", (err) => log(err.message, "error"));
    return listener;
  }

  function buildWs() {
    const listener = wire(
      new GlueWsListener({
        url: probe.transSocketUrl,
        staleTimeoutMs: config.wsStaleTimeoutMs,
        reconnectMaxMs: config.wsReconnectMaxMs,
        debugRaw: config.debugRaw,
        fetchLiveState: () =>
          apiRef.current.searchLive(courseId, subId),
        // 断线重连后用 search-trans-result 补齐漏掉的句子。
        // 跨源 dedupe key 对不齐（WS 为 w: 前缀），重复告警由每词冷却压制。
        fetchCatchUp: async ({ mode }) => {
          const { items } = await fetchItems();
          for (const fragment of items) {
            // 首连：静默登记全部历史，避免进场即对旧话告警；
            // 重连：只对 seen 之外（断线期间）的新句子渲染+匹配
            await pipeline.ingest(fragment, { silent: mode === "initial" });
          }
          log(`补齐完成：本通道累计登记 ${items.length} 条转写`, "info");
        },
      })
    );
    // 连续多次连接未收到数据 -> 降级轮询直到本场结束
    listener.on("error", (err) => {
      if (stopped || degraded) return;
      degraded = true;
      log(`WebSocket 多次重连失败：${err.message}，降级到轮询模式`, "warn");
      listener.stop();
      kind = "poll";
      current = buildPoll();
      current.start();
      onDegraded?.();
    });
    return listener;
  }

  return {
    start() {
      stopped = false;
      const usePoll =
        config.listenMode === "poll" ||
        (config.listenMode === "auto" && !probe.hasAsr);
      if (usePoll) {
        kind = "poll";
        log("未检测到平台实时字幕通道（或强制 poll），使用轮询模式，延迟未知", "warn");
        current = buildPoll();
      } else {
        kind = "ws";
        current = buildWs();
      }
      current.start();
    },
    stop() {
      stopped = true;
      current?.stop();
    },
    get kind() {
      return kind;
    },
    get degraded() {
      return degraded;
    },
  };
}
