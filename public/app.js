// 直播台页面：监控控制 + 实时字幕 + 告警历史。
// 共享工具（$ / el / toast / api / 连通性徽标 / openEvents / withBusy）见 shared.js。
// 安全约定：所有服务端来源文本一律 textContent / createTextNode，不拼 innerHTML。

let state = null; // 最近一次 /api/state
let courses = [];
let sessions = [];
let probeResult = null;
let keywords = []; // 当前生效关键词（用于字幕与告警高亮）
let interimEl = null;
let connected = false;
let autoScroll = true;
let sessionRequest = 0;
let pendingStart = false;

function updateControls() {
  const busy = pendingStart || ["running", "starting"].includes(state?.phase);
  $("btn-start").disabled = !connected || busy || !selectedSession();
  $("btn-stop").disabled = !connected || !busy;
  $("btn-reset").disabled = !connected || busy;
  $("btn-probe").disabled = !connected || busy || !selectedSession();
  for (const id of ["course-select", "session-select", "btn-load-courses", "btn-manual-course", "manual-course-id"]) {
    $(id).disabled = busy || (id === "course-select" && !courses.length) || (id === "session-select" && !sessions.length);
  }
  for (const radio of document.querySelectorAll('input[name="mode"]')) radio.disabled = busy;
  for (const button of pendingButtons) button.disabled = true;
}
function updatePageControls() {
  updateControls();
}

// 关键词高亮：纯文本分段 + <mark>，不做任何 innerHTML
function appendHighlighted(node, text) {
  if (!keywords.length) {
    node.appendChild(document.createTextNode(text));
    return;
  }
  const pattern = new RegExp(keywords.map(escapeRegExp).join("|"), "gi");
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index > last) node.appendChild(document.createTextNode(text.slice(last, m.index)));
    node.appendChild(el("mark", null, m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) node.appendChild(document.createTextNode(text.slice(last)));
}

function renderGate() {
  $("transcript-lock").classList.toggle("hidden", isVerified() || ["running", "ended", "stopped"].includes(state?.phase));
}

// ---------- 实时字幕 ----------

function transcriptPanel() {
  return $("transcript");
}

function clearTranscriptPlaceholder() {
  transcriptPanel().querySelector(".placeholder")?.remove();
}

function fillLine(line, fragment) {
  line.textContent = "";
  line.appendChild(el("span", "time", `[${fragment.displayTime}]`));
  appendHighlighted(line, fragment.text);
}

function scrollTranscript() {
  const panel = transcriptPanel();
  if (autoScroll) panel.scrollTop = panel.scrollHeight;
}

function trimTranscript() {
  const panel = transcriptPanel();
  while (panel.children.length > 800) panel.firstChild.remove();
}

function handleFragment(fragment) {
  clearTranscriptPlaceholder();
  const panel = transcriptPanel();

  if (!fragment.final && interimEl) {
    fillLine(interimEl, fragment); // 半句原地更新
    scrollTranscript();
    return;
  }
  if (fragment.final && interimEl) {
    // 同一句话定稿：转正当前 interim 行
    interimEl.classList.remove("interim");
    interimEl.classList.add("final");
    fillLine(interimEl, fragment);
    interimEl = null;
    trimTranscript();
    scrollTranscript();
    return;
  }

  const line = el("div", fragment.final ? "line final" : "line interim");
  fillLine(line, fragment);
  panel.appendChild(line);
  if (!fragment.final) interimEl = line;
  trimTranscript();
  scrollTranscript();
}

function handleFlush() {
  if (interimEl) {
    interimEl.classList.remove("interim");
    interimEl.classList.add("flushed");
    interimEl = null;
  }
}

function rebuildTranscript(entries) {
  const panel = transcriptPanel();
  panel.textContent = "";
  interimEl = null;
  for (const entry of entries) { handleFragment(entry); if (entry.flushed) handleFlush(); }
  if (!entries.length) {
    const placeholder = el("div", "placeholder");
    placeholder.append(el("span", "empty-symbol", "〰"), el("b", null, "等待课堂的第一句话"), el("span", null, "启动监控后，实时字幕将在这里呈现。"));
    panel.appendChild(placeholder);
  }
}

// ---------- 告警历史 ----------

let allAlerts = []; // 最新在前，与服务端 hello 同步
const alertFilter = { text: "", failOnly: false, hit: null };

function pushStatusCell(alert) {
  if (alert.sent) return el("span", "push-ok", "已推送");
  if (alert.reason === "disabled") return el("span", "push-off", "未启用");
  return el("span", "push-fail", `失败：${alert.reason || "未知"}`);
}

function alertRow(alert, fresh = false) {
  const row = el("tr", fresh ? "fresh" : null);
  const tdTime = el("td", null, new Date(alert.at).toLocaleTimeString("zh-CN"));
  const tdHits = el("td");
  for (const hit of alert.hits) {
    tdHits.appendChild(el("mark", null, hit));
    tdHits.appendChild(document.createTextNode(" "));
  }
  const tdSentence = el("td", "sentence");
  appendHighlighted(tdSentence, alert.sentence);
  const tdPush = el("td");
  tdPush.appendChild(pushStatusCell(alert));
  tdTime.title = new Date(alert.at).toLocaleString("zh-CN");
  tdSentence.title = `${alert.courseLabel || ""} · ${alert.sessionTitle || ""}`;
  row.append(tdTime, tdHits, tdSentence, tdPush);
  return row;
}

function alertMatches(a) {
  if (alertFilter.failOnly && a.sent) return false;
  if (alertFilter.hit && !a.hits.includes(alertFilter.hit)) return false;
  if (alertFilter.text) {
    const hay = `${a.hits.join(" ")} ${a.sentence}`.toLowerCase();
    if (!hay.includes(alertFilter.text.toLowerCase())) return false;
  }
  return true;
}

function renderAlertHitChips() {
  const box = $("alert-hit-chips");
  const hits = [...new Set(allAlerts.flatMap((a) => a.hits))];
  box.classList.toggle("hidden", !hits.length);
  box.replaceChildren();
  for (const hit of hits) {
    const chip = el("button", `chip-f${alertFilter.hit === hit ? " on" : ""}`, hit);
    chip.type = "button";
    chip.title = alertFilter.hit === hit ? "点击取消筛选" : `只看命中「${hit}」的告警`;
    chip.addEventListener("click", () => {
      alertFilter.hit = alertFilter.hit === hit ? null : hit;
      renderAlerts();
    });
    box.appendChild(chip);
  }
}

function renderAlerts() {
  const body = $("alerts-body");
  body.textContent = "";
  const shown = allAlerts.filter(alertMatches);
  if (!shown.length) {
    const row = el("tr", "alerts-empty");
    const cell = el("td", null, allAlerts.length ? "没有符合筛选条件的告警" : "暂无预警 · 命中关键词后会在这里留下记录");
    cell.colSpan = 4;
    row.appendChild(cell);
    body.appendChild(row);
  } else {
    for (const alert of shown) {
      const row = alertRow(alert, alert._fresh);
      alert._fresh = false;
      body.appendChild(row);
    }
  }
  $("alert-filter-count").textContent = allAlerts.length && (alertFilter.text || alertFilter.failOnly || alertFilter.hit)
    ? `${shown.length} / ${allAlerts.length} 条`
    : "";
  renderAlertHitChips();
}

function rememberAlert(alert, fresh = false) {
  alert._fresh = fresh;
  allAlerts.unshift(alert);
  while (allAlerts.length > 200) allAlerts.pop();
  renderAlerts();
}

function rebuildAlerts(alerts) {
  allAlerts = [...alerts].reverse();
  renderAlerts();
}

// ---------- 状态与控制区 ----------

const PHASE_LABEL = {
  idle: "待命",
  starting: "启动中",
  running: "● 直播中",
  ended: "已结束",
  stopped: "已停止",
  error: "错误",
};

function applyState(s) {
  state = s;
  keywords = s.config?.keywords ?? keywords;
  renderLiveKeywords();
  updateTaskMeta();

  const badge = $("phase-badge");
  badge.textContent = PHASE_LABEL[s.phase] || s.phase;
  badge.className = `badge ${s.phase}`;

  $("fragment-count").textContent = s.stats.fragments;
  $("alert-count").textContent = s.stats.alerts;
  $("task-description").textContent = s.course ? `${s.course.title} · ${s.session?.title || ""}${s.degraded ? " · 已降级为轮询" : ""}` : "选择课程与场次，开启你的课堂哨兵。";
  updateControls();
  renderGate();
  if (s.lastError) showControlError(s.lastError);
  const mode = document.querySelector('input[name="mode"]:checked').value;
  $("push-ding-wrap").classList.toggle("hidden", mode !== "replay" || !s.config?.enableDingtalk);
  // 恢复服务端验证状态（钉钉禁用视为"通过"，不阻塞字幕门控）
  applyStateToChecks(s);
  renderGate();
}

// ---------- 运行时长 / 通道 / 告警词速览 ----------

function channelLabel(s) {
  if (!s) return "";
  if (s.degraded) return "轮询 · 已降级";
  if (s.listenerKind === "ws") return "WebSocket 直连";
  if (s.listenerKind === "poll") return "轮询";
  return "";
}

function updateTaskMeta() {
  const meta = $("task-meta");
  if (!meta) return;
  const parts = [];
  if (["running", "starting"].includes(state?.phase) && state.startedAt) {
    parts.push(`已运行 ${fmtDuration(Date.now() - state.startedAt)}`);
  }
  const channel = channelLabel(state);
  if (channel) parts.push(`通道 ${channel}`);
  meta.textContent = "";
  for (const [i, part] of parts.entries()) {
    if (i) meta.appendChild(document.createTextNode(" · "));
    meta.appendChild(el("span", null, part));
  }
  meta.classList.toggle("hidden", !parts.length);
}

function renderLiveKeywords() {
  const box = $("live-keywords");
  if (!box) return;
  box.replaceChildren(...(keywords.length ? keywords.map((word) => el("span", null, word)) : [el("span", "kw-empty", "尚未设置")]));
}

// ---------- 字幕导出 / 复制 ----------

function transcriptLines() {
  return [...transcriptPanel().children]
    .filter((node) => node.className && node.className.split(" ").includes("line"))
    .map((node) => node.textContent.trim());
}

function exportTranscript() {
  const lines = transcriptLines();
  if (!lines.length) {
    toast("还没有可导出的字幕", "err");
    return;
  }
  const title = state?.course?.title ? `【${state.course.title}${state.session?.title ? ` · ${state.session.title}` : ""}】` : "";
  const header = `${title}ClassSentry 字幕导出 · ${new Date().toLocaleString("zh-CN")}\n\n`;
  const blob = new Blob([header + lines.join("\n")], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `字幕 - ${new Date().toISOString().slice(0, 16).replace("T", " ")}.txt`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast(`已导出 ${lines.length} 句字幕`, "ok");
}

async function copyTranscript() {
  const text = transcriptLines().join("\n");
  if (!text) {
    toast("还没有字幕可复制", "err");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast("字幕已复制到剪贴板", "ok");
  } catch {
    toast("复制失败（浏览器未授权剪贴板），可用「导出 TXT」", "err");
  }
}

function applyProbe() {
  const box = $("probe-result");
  if (!probeResult) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  box.textContent = "";
  const item = (label, value, good) => {
    box.appendChild(el("span", null, `${label} `));
    box.appendChild(el("span", good ? "good" : "bad", value));
  };
  item("直播", probeResult.live ? "直播中" : "未在直播", probeResult.live);
  item("ASR通道", probeResult.hasAsr ? "有" : "无", probeResult.hasAsr);
  item("ASR运行", probeResult.asrRunning ? "是" : "否", probeResult.asrRunning);
}

function showControlError(msg) {
  const box = $("control-error");
  if (!msg) {
    box.classList.add("hidden");
    return;
  }
  box.textContent = msg;
  box.classList.remove("hidden");
}

function selectedCourse() {
  return selectedOption($("course-select"), courses, "id");
}

function selectedSession() {
  return selectedOption($("session-select"), sessions, "subId");
}

// ---------- 课程/场次 ----------

async function loadCourses() {
  showControlError("");
  toast("正在加载课程（首次需登录，可能几秒）…");
  courses = await fetchCourses();
  fillCourseSelect($("course-select"), courses);
  toast(`已加载 ${courses.length} 门课程`, "ok");
  await loadSessions();
}

async function loadSessions() {
  showControlError("");
  const request = ++sessionRequest;
  const course = selectedCourse();
  sessions = [];
  probeResult = null;
  applyProbe();
  const select = $("session-select");
  select.replaceChildren(el("option", null, course ? "正在加载场次…" : "先选课程"));
  select.disabled = true;
  updateControls();
  if (!course) return;
  try {
    const data = await api(`/api/courses/${encodeURIComponent(course.id)}/sessions`);
    if (request !== sessionRequest) return;
    sessions = data.sessions;
    fillSessionSelect(select, sessions, (s) => `${s.title} (${s.startLabel}) [${s.statusText}]`);
    if (!sessions.length) select.appendChild(el("option", null, "该课程没有场次"));
  } catch (error) {
    if (request !== sessionRequest) return;
    select.replaceChildren(el("option", null, "加载失败，请重新选择课程"));
    throw error;
  } finally {
    if (request === sessionRequest) updateControls();
  }
}

async function runProbe() {
  showControlError("");
  const course = selectedCourse();
  const session = selectedSession();
  if (!course || !session) return;
  const request = sessionRequest;
  const result = await api("/api/probe", {
    method: "POST",
    body: JSON.stringify({ courseId: course.id, subId: session.subId }),
  });
  if (request !== sessionRequest || selectedSession()?.subId !== session.subId) return;
  probeResult = result;
  applyProbe();
}

async function startMonitor() {
  showControlError("");
  const course = selectedCourse();
  const session = selectedSession();
  if (!course || !session) {
    showControlError("请先选择课程和场次");
    return;
  }
  if (!isVerified()) {
    showControlError("请先在「设置」里完成智云与钉钉的连通性测试");
    location.href = "/settings";
    return;
  }
  const mode = document.querySelector('input[name="mode"]:checked').value;
  pendingStart = true;
  updateControls();
  try {
    const data = await api("/api/monitor/start", {
      method: "POST",
      body: JSON.stringify({ mode, course, session, pushDingtalk: $("push-ding").checked }),
    });
    applyState(data.state);
    if (data.state.phase === "running") toast(mode === "replay" ? "重放已启动" : "监控已启动", "ok");
  } catch (e) {
    showControlError(e.message);
  } finally {
    pendingStart = false;
    updateControls();
  }
}

async function stopMonitor() {
  const data = await api("/api/monitor/stop", { method: "POST" });
  applyState(data.state);
  toast("已停止");
}

async function resetMonitor() {
  const data = await api("/api/monitor/reset", { method: "POST" });
  applyState(data.state);
  probeResult = null;
  applyProbe();
}

// ---------- 实时事件 ----------

function setConnection(connectedNow) {
  connected = connectedNow;
  const label = connectedNow ? "已连接" : "重连中…";
  for (const id of ["connection-status", "overview-conn"]) {
    $(id).textContent = label;
    $(id).dataset.state = connectedNow ? "ok" : "offline";
  }
  updateControls();
}

function handleEvent(event) {
  switch (event.type) {
    case "hello":
      applyState(event.payload.state);
      keywords = event.payload.state.config?.keywords ?? [];
      rebuildTranscript(event.payload.transcript);
      rebuildAlerts(event.payload.alerts);
      break;
    case "state":
      if (event.payload.phase === "idle" && event.payload.course === null) rebuildTranscript([]);
      applyState(event.payload);
      break;
    case "status":
      if (event.payload.level === "error") toast(event.payload.msg, "err");
      break;
    case "fragment":
      handleFragment(event.payload);
      if (state) { state.stats.fragments++; $("fragment-count").textContent = state.stats.fragments; }
      break;
    case "transcript_flush":
      handleFlush();
      break;
    case "alert":
      rememberAlert(event.payload, true);
      if (state) { state.stats.alerts++; $("alert-count").textContent = state.stats.alerts; }
      toast(`命中关键词：${event.payload.hits.join("、")}`, "ok");
      break;
  }
}

// ---------- 绑定 ----------

$("btn-load-courses").addEventListener("click", () => withBusy($("btn-load-courses"), loadCourses, "正在加载…").catch((e) => showControlError(e.message)));
$("btn-manual-course").addEventListener("click", () => {
  const id = $("manual-course-id").value.trim();
  if (!id) return;
  courses = [{ id, title: `课程 ${id}`, teacher: "" }];
  fillCourseSelect($("course-select"), courses, "该课程暂无场次");
  loadSessions().catch((e) => showControlError(e.message));
});
$("session-select").addEventListener("change", () => { probeResult = null; applyProbe(); updateControls(); });
$("btn-autoscroll").addEventListener("click", () => {
  autoScroll = !autoScroll;
  $("btn-autoscroll").setAttribute("aria-pressed", String(autoScroll));
  $("btn-autoscroll").textContent = `自动滚动 · ${autoScroll ? "开" : "关"}`;
  scrollTranscript();
});
$("transcript").addEventListener("scroll", () => {
  const panel = transcriptPanel();
  if (autoScroll && panel.scrollHeight - panel.scrollTop - panel.clientHeight > 40) {
    autoScroll = false;
    $("btn-autoscroll").setAttribute("aria-pressed", "false");
    $("btn-autoscroll").textContent = "自动滚动 · 关";
  }
}, { passive: true });
$("course-select").addEventListener("change", () => loadSessions().catch((e) => showControlError(e.message)));
$("btn-probe").addEventListener("click", () => withBusy($("btn-probe"), runProbe, "探测中…").catch((e) => showControlError(e.message)));
$("btn-start").addEventListener("click", startMonitor);
$("btn-stop").addEventListener("click", () => stopMonitor().catch((e) => toast(e.message, "err")));
$("btn-reset").addEventListener("click", () => resetMonitor().catch((e) => toast(e.message, "err")));
$("btn-export-transcript").addEventListener("click", exportTranscript);
$("btn-copy-transcript").addEventListener("click", () => copyTranscript().catch(() => toast("复制失败", "err")));
$("alert-search").addEventListener("input", () => {
  alertFilter.text = $("alert-search").value.trim();
  renderAlerts();
});
$("btn-alert-fail").addEventListener("click", () => {
  alertFilter.failOnly = !alertFilter.failOnly;
  $("btn-alert-fail").setAttribute("aria-pressed", String(alertFilter.failOnly));
  $("btn-alert-fail").classList.toggle("on", alertFilter.failOnly);
  renderAlerts();
});
if (typeof setInterval === "function") setInterval(updateTaskMeta, 1000);
for (const radio of document.querySelectorAll('input[name="mode"]')) {
  radio.addEventListener("change", () => state && applyState(state));
}

// ---------- 启动 ----------

renderChecks();
renderGate();
openEvents(handleEvent, setConnection);
api("/api/state").then(applyState).catch(() => {});
