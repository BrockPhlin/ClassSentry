// 控制台共享工具：所有子页面共用的无模块脚本（保持全局作用域，便于测试与零构建）。
// 约定：页面脚本必须在本文件之后加载；此处仅放跨页面复用的能力。
// 安全约定：所有服务端来源文本一律 textContent / createTextNode，不拼 innerHTML。

function $(id) {
  return document.getElementById(id);
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function toast(msg, level = "info") {
  const box = el("div", `toast${level === "err" ? " err" : level === "ok" ? " ok" : ""}`, msg);
  box.title = "点击关闭";
  box.addEventListener("click", () => {
    box.classList.add("out");
    setTimeout(() => box.remove(), 180);
  });
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

// ---------- 通用忙碌包装 ----------

const pendingButtons = new Set();
async function withBusy(button, action, label = "处理中…") {
  if (button.disabled) return;
  const text = button.textContent;
  pendingButtons.add(button);
  button.disabled = true;
  button.textContent = label;
  try {
    await action();
  } finally {
    pendingButtons.delete(button);
    button.textContent = text;
    button.disabled = false;
    if (typeof updatePageControls === "function") updatePageControls();
  }
}

// ---------- 连通性徽标（每页侧栏底部都有） ----------

// 检查状态：zhiyun / ding → idle | testing | ok | fail | disabled
// 服务端记录最近一次验证结果（/api/state 与 hello 快照带出），跨页面保持一致；
// 修改对应配置即失效；页面内的临时状态（测试中/失败）优先于快照。
const checks = { zhiyun: "idle", ding: "idle" };
const checkDetails = { zhiyun: "", ding: "" };
const CHECK_LABEL = {
  idle: "未测试",
  testing: "测试中…",
  ok: "已连通",
  fail: "失败",
  disabled: "未启用",
};

function isVerified() {
  return checks.zhiyun === "ok" && (checks.ding === "ok" || checks.ding === "disabled");
}

function setCheck(which, value, detail) {
  checks[which] = value;
  if (detail !== undefined) checkDetails[which] = detail;
  if (value === "idle" || value === "testing") checkDetails[which] = "";
  renderChecks();
}

function renderChecks() {
  for (const which of ["zhiyun", "ding"]) {
    const v = checks[which];
    const chip = which === "zhiyun" ? $("chip-zhiyun") : $("chip-ding");
    if (chip) {
      const led = which === "zhiyun" ? $("led-zhiyun") : $("led-ding");
      chip.dataset.state = v;
      led.className = `led ${v === "ok" ? "ok" : v === "fail" ? "fail" : v === "testing" ? "testing" : "off"}`;
      chip.querySelector("b").textContent = CHECK_LABEL[v];
    }
    // 详细状态行只存在于设置页
    const status = which === "zhiyun" ? $("zhiyun-status") : $("ding-status");
    if (status) {
      status.textContent = checkDetails[which] || CHECK_LABEL[v];
      status.className = `conn-status ${v === "ok" ? "ok" : v === "fail" ? "fail" : v === "testing" ? "testing" : ""}`;
    }
  }
}

// 把 /api/state 的配置同步进徽标（钉钉关闭视为"未启用"）
function applyConfigToChecks(config) {
  if (!config) return;
  if (config.enableDingtalk === false && checks.ding !== "testing") {
    setCheck("ding", "disabled", "推送已关闭");
  } else if (config.enableDingtalk && checks.ding === "disabled") {
    setCheck("ding", "idle");
  }
}

// 服务端记录的最近一次连通验证 → 徽标初值（换页不再回到"未测试"）
function applyVerifiedToChecks(verified) {
  if (!verified) return;
  for (const which of ["zhiyun", "ding"]) {
    if (checks[which] === "testing" || checks[which] === "disabled") continue;
    const record = verified[which];
    if (record?.at) {
      const when = new Date(record.at).toLocaleString("zh-CN", {
        month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
      });
      setCheck(which, "ok", record.detail ? `${record.detail} · ${when}` : `已验证 · ${when}`);
    }
  }
}

// 页面拿到状态快照（/api/state 或 hello）后统一调用
function applyStateToChecks(state) {
  if (!state) return;
  applyConfigToChecks(state.config);
  applyVerifiedToChecks(state.verified);
}

// ---------- 实时事件 ----------

// 建立 SSE；返回连接是否存活由回调与页面自行处理。
// onEvent(event) 收到 {type, payload}；onConnect(connected) 在连接状态变化时回调。
function openEvents(onEvent, onConnect) {
  const es = new EventSource("/api/events");
  es.onopen = () => onConnect?.(true);
  es.onerror = () => onConnect?.(false);
  es.onmessage = (msg) => {
    let event;
    try {
      event = JSON.parse(msg.data);
    } catch {
      return;
    }
    onEvent?.(event);
  };
  return es;
}

// ---------- 课程 / 场次（直播台与课件页共用） ----------

async function fetchCourses() {
  const data = await api("/api/courses");
  return Array.isArray(data.courses) ? data.courses : [];
}

function fillCourseSelect(select, courses, emptyHint = "暂无课程，可手动输入 ID") {
  select.textContent = "";
  for (const c of courses) {
    const option = el("option", null, `${c.title}${c.teacher ? ` - ${c.teacher}` : ""}`);
    option.value = c.id;
    select.appendChild(option);
  }
  select.disabled = !courses.length;
  if (!courses.length) select.appendChild(el("option", null, emptyHint));
}

async function fetchSessions(courseId) {
  const data = await api(`/api/courses/${encodeURIComponent(courseId)}/sessions`);
  return Array.isArray(data.sessions) ? data.sessions : [];
}

function fillSessionSelect(select, sessions, formatter) {
  select.textContent = "";
  for (const s of sessions) {
    const option = el("option", null, formatter ? formatter(s) : s.title || String(s.subId));
    option.value = s.subId;
    select.appendChild(option);
  }
  select.disabled = !sessions.length;
  if (!sessions.length) select.appendChild(el("option", null, "该课程暂无场次"));
}

// localStorage 可能在隐私模式/测试环境中不可用，统一走这里，拿不到就静默降级为不记忆。
const store = (() => {
  try {
    if (typeof localStorage === "undefined") return null;
    const probe = "__classsentry_probe__";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
})();

function storeGet(key, fallback = null) {
  if (!store) return fallback;
  try {
    const raw = store.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function storeSet(key, value) {
  if (!store) return;
  try {
    store.setItem(key, JSON.stringify(value));
  } catch {
    /* 配额满等情况静默忽略 */
  }
}

function selectedOption(select, items, key) {
  const id = select.value;
  if (!id) return null;
  return items.find((item) => String(item[key]) === String(id)) || null;
}

// 毫秒时长 → 「1 小时 2 分 / 3 分 4 秒 / 5 秒」
function fmtDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const hours = Math.floor(minutes / 60);
  if (hours) return `${hours} 小时 ${minutes % 60} 分`;
  if (minutes) return `${minutes} 分 ${total % 60} 秒`;
  return `${total} 秒`;
}
