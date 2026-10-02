// 课件库页面：选择课程场次，导出课件/板书 PPTX，附场次信息与本机导出历史。共享工具见 shared.js。

let courses = [];
let sessions = [];
let sessionRequest = 0;

const LAST_CHOICE_KEY = "deck.lastChoice";
const HISTORY_KEY = "deck.history";

function deckCourse() {
  return selectedOption($("course-select"), courses, "id");
}

function deckSession() {
  return selectedOption($("session-select"), sessions, "subId");
}

function updateDeckControls() {
  $("btn-deck").disabled = !deckCourse() || !deckSession();
  renderSessionInfo();
}

function renderSessionInfo() {
  const box = $("session-info");
  const session = deckSession();
  box.classList.toggle("hidden", !session);
  if (!session) return;
  box.replaceChildren(
    el("span", null, "开始 "),
    el("span", "good", session.startLabel || "未知"),
    el("span", null, "状态 "),
    el("span", session.status === "1" ? "good" : "bad", session.statusText || "未知"),
  );
}

async function loadCourses() {
  showDeckError("");
  toast("正在加载课程（首次需登录，可能几秒）…");
  courses = await fetchCourses();
  fillCourseSelect($("course-select"), courses);
  toast(`已加载 ${courses.length} 门课程`, "ok");
  const last = storeGet(LAST_CHOICE_KEY);
  if (last?.courseId && courses.some((c) => String(c.id) === String(last.courseId))) {
    $("course-select").value = String(last.courseId);
  }
  await loadSessions();
}

async function loadSessions() {
  showDeckError("");
  const request = ++sessionRequest;
  const course = deckCourse();
  sessions = [];
  const select = $("session-select");
  select.replaceChildren(el("option", null, course ? "正在加载场次…" : "先选课程"));
  select.disabled = true;
  updateDeckControls();
  if (!course) return;
  try {
    const data = await api(`/api/courses/${encodeURIComponent(course.id)}/sessions`);
    if (request !== sessionRequest) return;
    sessions = data.sessions;
    fillSessionSelect(select, sessions, (s) => `${s.title} (${s.startLabel}) [${s.statusText}]`);
    if (!sessions.length) select.appendChild(el("option", null, "该课程没有场次"));
    const last = storeGet(LAST_CHOICE_KEY);
    if (last?.subId && sessions.some((s) => String(s.subId) === String(last.subId)) && String(last.courseId) === String(course.id)) {
      select.value = String(last.subId);
    }
  } catch (error) {
    if (request !== sessionRequest) return;
    select.replaceChildren(el("option", null, "加载失败，请重新选择课程"));
    throw error;
  } finally {
    if (request === sessionRequest) updateDeckControls();
  }
}

function rememberChoice() {
  const course = deckCourse();
  const session = deckSession();
  if (course && session) storeSet(LAST_CHOICE_KEY, { courseId: course.id, subId: session.subId });
}

function showDeckError(msg) {
  const box = $("deck-error");
  if (!msg) {
    box.classList.add("hidden");
    return;
  }
  box.textContent = msg;
  box.classList.remove("hidden");
}

function safeName(s) {
  return String(s || "").replace(/[\\/:*?"<>|]/g, " ").trim();
}

function deckParams(entry) {
  const course = entry ? { id: entry.courseId, title: entry.courseTitle } : deckCourse();
  const session = entry ? { subId: entry.subId, title: entry.sessionTitle } : deckSession();
  if (!course || !session) throw new Error("请先选择课程和场次");
  return { course, session };
}

async function downloadDeck(entry = null) {
  const { course, session } = deckParams(entry);
  toast("正在生成课件 PPT（逐页下载截图），可能需要一两分钟…");
  const params = new URLSearchParams({
    courseId: course.id,
    subId: session.subId,
    courseTitle: course.title || "",
    title: session.title || "",
  });
  const res = await fetch(`/api/deck?${params}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error?.message || `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const file = `${safeName(course.title) || "课堂课件"} - ${safeName(session.title) || "课件"}.pptx`;
  link.href = url;
  link.download = file;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast(`课件 PPT 已生成（${Math.round(blob.size / 1024)} KB）`, "ok");
  rememberExport({
    at: Date.now(),
    file,
    kb: Math.round(blob.size / 1024),
    courseId: course.id,
    subId: session.subId,
    courseTitle: course.title || "",
    sessionTitle: session.title || "",
  });
}

// ---------- 导出历史（仅存本机浏览器） ----------

function rememberExport(entry) {
  const history = storeGet(HISTORY_KEY, []);
  history.unshift(entry);
  storeSet(HISTORY_KEY, history.slice(0, 10));
  renderDeckHistory();
}

function renderDeckHistory() {
  const box = $("deck-history");
  const history = storeGet(HISTORY_KEY, []);
  $("btn-deck-clear-history").classList.toggle("hidden", !history.length);
  box.replaceChildren();
  if (!history.length) {
    box.appendChild(el("p", "note", "还没有导出记录 · 第一次成功导出后会显示在这里，可一键重新生成。"));
    return;
  }
  for (const entry of history) {
    const row = el("div", "deck-history-item");
    const meta = el("div", "deck-history-meta");
    meta.appendChild(el("b", null, entry.file));
    meta.appendChild(el("span", null, `${new Date(entry.at).toLocaleString("zh-CN")} · ${entry.kb} KB`));
    row.appendChild(meta);
    const again = el("button", "small-button", "再次导出");
    again.type = "button";
    again.title = "用同样的课程场次重新生成一次 PPT";
    again.addEventListener("click", () => {
      again.disabled = true;
      return downloadDeck(entry)
        .catch((e) => showDeckError(e.message))
        .finally(() => {
          again.disabled = false;
        });
    });
    row.appendChild(again);
    box.appendChild(row);
  }
}

// ---------- 实时事件（恢复连通性徽标与连接状态点） ----------

function handleEvent(event) {
  if (event.type === "hello") applyStateToChecks(event.payload.state);
}

function setConnection(connectedNow) {
  const node = $("connection-status");
  node.textContent = connectedNow ? "已连接" : "重连中…";
  node.dataset.state = connectedNow ? "ok" : "offline";
}

// ---------- 绑定 ----------

$("btn-load-courses").addEventListener("click", () => withBusy($("btn-load-courses"), loadCourses, "正在加载…").catch((e) => showDeckError(e.message)));
$("course-select").addEventListener("change", () => loadSessions().catch((e) => showDeckError(e.message)));
$("session-select").addEventListener("change", () => {
  rememberChoice();
  updateDeckControls();
});
$("btn-deck").addEventListener("click", () => {
  rememberChoice();
  withBusy($("btn-deck"), () => downloadDeck(), "生成中…").catch((e) => showDeckError(e.message));
});
$("btn-deck-clear-history").addEventListener("click", () => {
  storeSet(HISTORY_KEY, []);
  renderDeckHistory();
  toast("已清空导出记录");
});

renderChecks();
renderDeckHistory();
openEvents(handleEvent, setConnection);
