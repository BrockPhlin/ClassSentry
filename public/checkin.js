// 自动签到页面：学在浙大点名的开关与记录。共享工具见 shared.js。

let checkinState = null;
const seenCheckinKeys = new Set(); // 已弹过 toast 的签到终态，去重用
let checkinSnapshotSeen = false; // 首次快照只记录不弹 toast，避免进入页面时轰炸
let checkinFailOnly = false; // 记录表「只看失败」筛选

function checkinButtonLabel() {
  return ["starting", "running"].includes(checkinState?.phase) ? "■ 停止签到" : "▷ 开启签到";
}

function renderMiniStats(cs) {
  const box = $("checkin-mini-stats");
  const show = Boolean(cs.stats) && (cs.phase !== "idle" || (cs.results?.length ?? 0) > 0);
  box.classList.toggle("hidden", !show);
  if (!show) return;
  $("stat-answered").textContent = cs.stats.answered;
  $("stat-failed").textContent = cs.stats.failed;
  $("stat-active").textContent = cs.stats.active ?? 0;
  const runtime = ["starting", "running"].includes(cs.phase) && cs.startedAt ? fmtDuration(Date.now() - cs.startedAt) : "—";
  $("stat-runtime").textContent = runtime;
}

function applyCheckinState(cs) {
  if (!cs) return;
  checkinState = cs;
  const active = ["starting", "running"].includes(cs.phase);
  const button = $("btn-checkin");
  button.textContent = checkinButtonLabel();
  button.classList.toggle("on", active);

  const box = $("checkin-status");
  if (cs.phase === "idle" && !cs.results?.length) {
    box.classList.add("hidden");
  } else {
    box.classList.remove("hidden");
    box.replaceChildren();
    box.appendChild(el("span", null, CHECKIN_PHASE_LABEL[cs.phase] || cs.phase));
    const sep = () => box.appendChild(document.createTextNode(" · "));
    if (cs.stats) {
      sep();
      box.appendChild(el("span", "good", `已签到 ${cs.stats.answered}`));
      if (cs.stats.failed) {
        sep();
        box.appendChild(el("span", "bad", `失败 ${cs.stats.failed}`));
      }
    }
    if (active && cs.stats) {
      sep();
      box.appendChild(el("span", null, `无点名 ${Math.max(1, Math.round((cs.idleStopMs || 0) / 60000))} 分钟后自动停止`));
    }
    if (cs.phase === "stopped" && cs.stopReason) {
      sep();
      box.appendChild(el("span", null, CHECKIN_STOP_REASON[cs.stopReason] || cs.stopReason));
    }
    if (cs.phase === "error" && cs.lastError) {
      sep();
      box.appendChild(el("span", "bad", cs.lastError));
    }
  }

  // 新出现的终态弹 toast（key 含 at，重试后再次终态会重新提示）
  for (const r of cs.results || []) {
    if (r.outcome === "attempting") continue;
    const key = `${r.rollcallId}:${r.outcome}:${r.at}`;
    if (seenCheckinKeys.has(key)) continue;
    seenCheckinKeys.add(key);
    if (!checkinSnapshotSeen) continue;
    const name = r.courseTitle || `点名 #${r.rollcallId}`;
    if (r.outcome === "success") toast(`已自动签到：${name}${r.detail ? ` · ${r.detail}` : ""}`, "ok");
    else if (r.outcome === "unsupported") toast(`暂不支持该点名类型：${name}`, "err");
    else toast(`自动签到失败：${name}${r.detail ? ` · ${r.detail}` : ""}`, "err");
  }
  checkinSnapshotSeen = true;

  renderMiniStats(cs);
  renderCheckinResults(cs);
}

const CHECKIN_PHASE_LABEL = {
  idle: "空闲",
  starting: "启动中…",
  running: "轮询中",
  stopped: "已停止",
  error: "错误",
};
const CHECKIN_STOP_REASON = { manual: "手动停止", idle: "长时间无点名", errors: "连续出错" };
const CHECKIN_KIND_LABEL = { radar: "雷达", number: "数字", unknown: "未知" };

function renderCheckinResults(cs) {
  const body = $("checkin-results");
  body.textContent = "";
  const results = (cs.results || []).filter((r) => !checkinFailOnly || r.outcome === "failed");
  $("checkin-stats").textContent = cs.stats
    ? `已签到 ${cs.stats.answered} · 失败 ${cs.stats.failed}${checkinFailOnly ? ` · 显示 ${results.length} 条` : ""}`
    : "";
  if (!results.length) {
    const row = el("tr", "alerts-empty");
    const cell = el("td", null, cs.results?.length ? "没有失败的记录" : "暂无签到记录 · 点「开启签到」后，点名的应答结果会在这里呈现");
    cell.colSpan = 4;
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }
  for (const r of results) {
    const row = el("tr");
    const tdTime = el("td", null, new Date(r.at).toLocaleTimeString("zh-CN"));
    tdTime.title = new Date(r.at).toLocaleString("zh-CN");
    row.append(
      tdTime,
      el("td", null, r.courseTitle || `点名 #${r.rollcallId}`),
      el("td", null, CHECKIN_KIND_LABEL[r.kind] || r.kind || "未知"),
    );
    const tdOutcome = el("td");
    const label =
      r.outcome === "success" ? `已签到${r.detail ? ` · ${r.detail}` : ""}`
      : r.outcome === "attempting" ? "尝试中…"
      : r.outcome === "unsupported" ? "暂不支持"
      : `失败${r.detail ? ` · ${r.detail}` : ""}`;
    const cls = r.outcome === "success" ? "push-ok" : r.outcome === "attempting" || r.outcome === "unsupported" ? "push-off" : "push-fail";
    tdOutcome.appendChild(el("span", r.outcome === "attempting" ? `${cls} live` : cls, label));
    row.appendChild(tdOutcome);
    body.appendChild(row);
  }
}

async function toggleCheckin() {
  const active = ["starting", "running"].includes(checkinState?.phase);
  const data = await api(active ? "/api/checkin/stop" : "/api/checkin/start", { method: "POST" });
  applyCheckinState(data.state);
}

// ---------- 实时事件与绑定 ----------

function handleEvent(event) {
  if (event.type === "hello") {
    applyStateToChecks(event.payload.state);
    applyCheckinState(event.payload.checkin);
  } else if (event.type === "checkin") {
    applyCheckinState(event.payload);
  }
}

function setConnection(connectedNow) {
  const node = $("connection-status");
  node.textContent = connectedNow ? "已连接" : "重连中…";
  node.dataset.state = connectedNow ? "ok" : "offline";
}

// 切换会改变自身按钮文案，不走 withBusy（其结束后会恢复过期文案）
$("btn-checkin").addEventListener("click", async () => {
  const button = $("btn-checkin");
  if (button.disabled) return;
  pendingButtons.add(button);
  button.disabled = true;
  button.textContent = "处理中…";
  try {
    await toggleCheckin();
  } catch (e) {
    toast(e.message, "err");
  } finally {
    pendingButtons.delete(button);
    button.disabled = false;
    button.textContent = checkinButtonLabel();
  }
});

// 「只看失败」只影响记录表渲染，不改变按钮文案
$("btn-checkin-fail").addEventListener("click", () => {
  checkinFailOnly = !checkinFailOnly;
  $("btn-checkin-fail").setAttribute("aria-pressed", String(checkinFailOnly));
  $("btn-checkin-fail").classList.toggle("on", checkinFailOnly);
  if (checkinState) renderCheckinResults(checkinState);
});
if (typeof setInterval === "function") {
  setInterval(() => { if (checkinState) renderMiniStats(checkinState); }, 1000);
}

renderChecks();
openEvents(handleEvent, setConnection);
