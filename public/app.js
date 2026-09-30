// class_notice_bot ON-AIR 控制台（原生 JS，无构建）。
// 安全约定：所有服务端来源文本一律 textContent / createTextNode，不拼 innerHTML。

const $ = (id) => document.getElementById(id);

let state = null; // 最近一次 /api/state
let courses = [];
let sessions = [];
let probeResult = null;
let keywords = [];
let interimEl = null;

// 连通性检查：zhiyun / ding → idle | testing | ok | fail | disabled
const checks = {
  zhiyun: localStorage.getItem("cnb-z") || "idle",
  ding: localStorage.getItem("cnb-d") || "idle",
};
const CHECK_LABEL = {
  idle: "未测试",
  testing: "测试中…",
  ok: "已连通",
  fail: "失败",
  disabled: "未启用",
};

function saveChecks() {
  localStorage.setItem("cnb-z", checks.zhiyun);
  localStorage.setItem("cnb-d", checks.ding);
}

function isVerified() {
  return checks.zhiyun === "ok" && (checks.ding === "ok" || checks.ding === "disabled");
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function toast(msg, level = "info") {
  const box = el("div", `toast${level === "err" ? " err" : level === "ok" ? " ok" : ""}`, msg);
  $("toasts").appendChild(box);
  setTimeout(() => box.remove(), 4200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
  return data;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

// ---------- 连通性状态 ----------

const checkDetails = { zhiyun: "", ding: "" };

function setCheck(which, value, detail) {
  checks[which] = value;
  if (detail !== undefined) checkDetails[which] = detail;
  if (value === "idle" || value === "testing") checkDetails[which] = "";
  saveChecks();
  renderChecks();
  renderGate();
}

function renderChecks() {
  for (const which of ["zhiyun", "ding"]) {
    const v = checks[which];
    const chip = which === "zhiyun" ? $("chip-zhiyun") : $("chip-ding");
    const led = which === "zhiyun" ? $("led-zhiyun") : $("led-ding");
    const status = which === "zhiyun" ? $("zhiyun-status") : $("ding-status");
    chip.dataset.state = v;
    led.className = `led ${v === "ok" ? "ok" : v === "fail" ? "fail" : v === "testing" ? "testing" : "off"}`;
    chip.querySelector("b").textContent = CHECK_LABEL[v];
    status.textContent = checkDetails[which] || CHECK_LABEL[v];
    status.className = `conn-status ${v === "ok" ? "ok" : v === "fail" ? "fail" : v === "testing" ? "testing" : ""}`;
  }
}

function renderGate() {
  $("transcript-lock").classList.toggle("hidden", isVerified());
}

function openSettings() {
  $("settings-modal").showModal();
  loadSettings().catch((e) => toast(e.message, "err"));
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
  panel.scrollTop = panel.scrollHeight;
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
  for (const entry of entries) handleFragment(entry);
}

// ---------- 告警历史 ----------

function pushStatusCell(alert) {
  if (alert.sent) return el("span", "push-ok", "已推送");
  if (alert.reason === "disabled") return el("span", "push-off", "未启用");
  return el("span", "push-fail", `失败：${alert.reason || "未知"}`);
}

function prependAlert(alert) {
  const body = $("alerts-body");
  body.querySelector(".alerts-empty")?.remove();
  const row = el("tr");
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
  row.append(tdTime, tdHits, tdSentence, tdPush);
  body.prepend(row);
  while (body.children.length > 200) body.lastChild.remove();
}

function rebuildAlerts(alerts) {
  const body = $("alerts-body");
  body.textContent = "";
  if (!alerts.length) {
    body.appendChild(el("div", "alerts-empty", "暂无告警"));
    return;
  }
  for (const alert of [...alerts].reverse()) prependAlert(alert);
}

// ---------- 状态与控制区 ----------

const PHASE_LABEL = {
  idle: "STANDBY",
  starting: "STARTING",
  running: "● ON-AIR",
  ended: "ENDED",
  stopped: "STOPPED",
  error: "ERROR",
};

function applyState(s) {
  state = s;
  keywords = s.config?.keywords ?? keywords;

  const badge = $("phase-badge");
  badge.textContent = PHASE_LABEL[s.phase] || s.phase;
  badge.className = `badge ${s.phase}`;
  $("stats").textContent = `T ${s.stats.fragments} · A ${s.stats.alerts}`;

  const busy = s.phase === "running" || s.phase === "starting";
  $("btn-start").disabled = busy;
  $("btn-stop").disabled = !busy;
  $("btn-reset").disabled = busy;
  $("btn-probe").disabled = busy || !$("session-select").value;

  const mode = document.querySelector('input[name="mode"]:checked').value;
  $("push-ding-wrap").classList.toggle("hidden", mode !== "replay" || !s.config?.enableDingtalk);

  // 钉钉被禁用视为"通过"，不阻塞字幕门控
  if (s.config && s.config.enableDingtalk === false && checks.ding !== "ok") {
    checks.ding = "disabled";
    saveChecks();
    renderChecks();
    renderGate();
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
  const id = $("course-select").value;
  if (!id) return null;
  return courses.find((c) => String(c.id) === String(id)) || { id, title: `课程 ${id}`, teacher: "" };
}

function selectedSession() {
  const subId = $("session-select").value;
  if (!subId) return null;
  return sessions.find((s) => String(s.subId) === String(subId)) || null;
}

// ---------- 课程/场次 ----------

async function loadCourses() {
  showControlError("");
  toast("正在加载课程（首次需登录，可能几秒）…");
  const data = await api("/api/courses");
  courses = data.courses;
  const select = $("course-select");
  select.textContent = "";
  for (const c of courses) {
    const option = el("option", null, `${c.title}${c.teacher ? ` - ${c.teacher}` : ""}`);
    option.value = c.id;
    select.appendChild(option);
  }
  select.disabled = false;
  const sessionSelect = $("session-select");
  sessionSelect.textContent = "";
  sessionSelect.appendChild(el("option", null, "先选课程"));
  sessionSelect.disabled = true;
  toast(`已加载 ${courses.length} 门课程`, "ok");
}

async function loadSessions() {
  showControlError("");
  const course = selectedCourse();
  if (!course) return;
  $("btn-probe").disabled = true;
  const data = await api(`/api/courses/${encodeURIComponent(course.id)}/sessions`);
  sessions = data.sessions;
  const select = $("session-select");
  select.textContent = "";
  if (!sessions.length) {
    select.appendChild(el("option", null, "该课程没有场次"));
    select.disabled = true;
    return;
  }
  for (const s of sessions) {
    const option = el("option", null, `${s.title} (${s.startLabel}) [${s.statusText}]`);
    option.value = s.subId;
    select.appendChild(option);
  }
  select.disabled = false;
  $("btn-probe").disabled = false;
}

async function runProbe() {
  showControlError("");
  const course = selectedCourse();
  const session = selectedSession();
  if (!course || !session) return;
  probeResult = await api("/api/probe", {
    method: "POST",
    body: JSON.stringify({ courseId: course.id, subId: session.subId }),
  });
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
    openSettings();
    return;
  }
  const mode = document.querySelector('input[name="mode"]:checked').value;
  try {
    const data = await api("/api/monitor/start", {
      method: "POST",
      body: JSON.stringify({ mode, course, session, pushDingtalk: $("push-ding").checked }),
    });
    applyState(data.state);
    toast(mode === "replay" ? "重放已启动" : "监控已启动", "ok");
  } catch (e) {
    showControlError(e.message);
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

// ---------- 关键词（主界面） ----------

async function applyKeywords() {
  const text = $("kw-input").value.trim();
  const cooldown = Number($("kw-cooldown").value) || 120;
  await api("/api/settings", {
    method: "PUT",
    body: JSON.stringify({ keywords: text, keywordCooldownSeconds: cooldown }),
  });
  toast("关键词已保存，对下一次监控任务生效", "ok");
}

// ---------- 设置弹窗 ----------

function fillSettings(settings) {
  $("set-username").value = settings.zjuUsername || "";
  $("set-password").value = "";
  $("set-password").placeholder = settings.hasPassword ? "已设置，留空保持不变" : "未设置";
  $("set-ding-enabled").checked = settings.dingtalk.enabled;
  $("set-ding-webhook").value = settings.dingtalk.webhook || "";
  $("set-ding-webhook").placeholder = "https://oapi.dingtalk.com/robot/send?access_token=...";
  $("set-ding-secret").value = "";
  $("set-ding-secret").placeholder = settings.dingtalk.hasSecret ? "已设置，留空保持不变" : "SEC 开头的加签密钥（关键词模式留空）";
  $("set-alert-title").value = settings.alertTitle;
  $("set-listen-mode").value = settings.listenMode;
  $("set-poll-interval").value = settings.pollIntervalSeconds;
  $("set-final-only").checked = settings.alertOnFinalOnly;
  $("set-debug-raw").checked = settings.debugRaw;
  if (settings.dingtalk.enabled === false && checks.ding !== "ok") setCheck("ding", "disabled");
}

async function loadSettings() {
  fillSettings(await api("/api/settings"));
}

async function saveZhiyunAndTest(btn) {
  const body = { zjuUsername: $("set-username").value.trim() };
  const password = $("set-password").value;
  if (password) body.password = password;

  btn.disabled = true;
  setCheck("zhiyun", "testing");
  try {
    await api("/api/settings", { method: "PUT", body: JSON.stringify(body) });
    const r = await api("/api/login-test", { method: "POST" });
    setCheck("zhiyun", "ok", `${r.courseCount} 门课 · ${(r.elapsedMs / 1000).toFixed(1)}s`);
    toast("智云登录成功", "ok");
  } catch (e) {
    setCheck("zhiyun", "fail", e.message);
    toast(`智云：${e.message}`, "err");
  } finally {
    btn.disabled = false;
  }
}

async function saveDingAndTest(btn) {
  const enabled = $("set-ding-enabled").checked;
  const body = {
    dingtalk: {
      enabled,
      webhook: $("set-ding-webhook").value.trim(),
    },
  };
  const secret = $("set-ding-secret").value.trim();
  if (secret) body.dingtalk.secret = secret;

  btn.disabled = true;
  setCheck("ding", "testing");
  try {
    await api("/api/settings", { method: "PUT", body: JSON.stringify(body) });
    if (!enabled) {
      setCheck("ding", "disabled", "推送已关闭");
      toast("钉钉推送已关闭", "ok");
      return;
    }
    const r = await api("/api/settings/test-ding", { method: "POST" });
    if (r.ok) {
      setCheck("ding", "ok", "测试消息已发送");
      toast("钉钉测试消息已发送，请到群里确认", "ok");
    } else {
      setCheck("ding", "fail", r.error);
      toast(`钉钉：${r.error}`, "err");
    }
  } catch (e) {
    setCheck("ding", "fail", e.message);
    toast(`钉钉：${e.message}`, "err");
  } finally {
    btn.disabled = false;
  }
}

async function saveAdvanced(btn) {
  btn.disabled = true;
  try {
    await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        alertTitle: $("set-alert-title").value,
        listenMode: $("set-listen-mode").value,
        pollIntervalSeconds: Number($("set-poll-interval").value),
        alertOnFinalOnly: $("set-final-only").checked,
        debugRaw: $("set-debug-raw").checked,
      }),
    });
    toast("高级选项已保存，对下一次监控任务生效", "ok");
  } catch (e) {
    toast(e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

// ---------- SSE ----------

function connectEvents() {
  const es = new EventSource("/api/events");
  es.onmessage = (msg) => {
    let event;
    try {
      event = JSON.parse(msg.data);
    } catch {
      return;
    }
    switch (event.type) {
      case "hello":
        applyState(event.payload.state);
        keywords = event.payload.state.config?.keywords ?? [];
        rebuildTranscript(event.payload.transcript);
        rebuildAlerts(event.payload.alerts);
        break;
      case "state":
        applyState(event.payload);
        break;
      case "status":
        if (event.payload.level === "error") toast(event.payload.msg, "err");
        break;
      case "fragment":
        handleFragment(event.payload);
        break;
      case "transcript_flush":
        handleFlush();
        break;
      case "alert":
        prependAlert(event.payload);
        toast(`命中关键词：${event.payload.hits.join("、")}`, "ok");
        break;
    }
  };
}

// ---------- 绑定 ----------

$("btn-load-courses").addEventListener("click", () => loadCourses().catch((e) => showControlError(e.message)));
$("btn-manual-course").addEventListener("click", () => {
  const id = $("manual-course-id").value.trim();
  if (!id) return;
  courses = [{ id, title: `课程 ${id}`, teacher: "" }];
  const select = $("course-select");
  select.textContent = "";
  const option = el("option", null, `课程 ${id}`);
  option.value = id;
  select.appendChild(option);
  select.disabled = false;
  loadSessions().catch((e) => showControlError(e.message));
});
$("course-select").addEventListener("change", () => loadSessions().catch((e) => showControlError(e.message)));
$("btn-probe").addEventListener("click", () => runProbe().catch((e) => showControlError(e.message)));
$("btn-start").addEventListener("click", startMonitor);
$("btn-stop").addEventListener("click", () => stopMonitor().catch((e) => toast(e.message, "err")));
$("btn-reset").addEventListener("click", () => resetMonitor().catch((e) => toast(e.message, "err")));
for (const radio of document.querySelectorAll('input[name="mode"]')) {
  radio.addEventListener("change", () => state && applyState(state));
}

$("btn-apply-kw").addEventListener("click", () => applyKeywords().catch((e) => toast(e.message, "err")));

$("btn-open-settings").addEventListener("click", openSettings);
$("chip-zhiyun").addEventListener("click", openSettings);
$("chip-ding").addEventListener("click", openSettings);
$("btn-lock-settings").addEventListener("click", openSettings);
$("btn-close-settings").addEventListener("click", () => $("settings-modal").close());
$("btn-save-test-zhiyun").addEventListener("click", (e) => saveZhiyunAndTest(e.currentTarget));
$("btn-save-test-ding").addEventListener("click", (e) => saveDingAndTest(e.currentTarget));
$("btn-save-advanced").addEventListener("click", (e) => saveAdvanced(e.currentTarget));

// ---------- 启动 ----------

renderChecks();
renderGate();
connectEvents();
api("/api/state").then(applyState).catch(() => {});
api("/api/settings")
  .then((settings) => {
    if (!$("kw-input").value) $("kw-input").value = settings.keywords || "";
    $("kw-cooldown").value = settings.keywordCooldownSeconds;
  })
  .catch(() => {});
