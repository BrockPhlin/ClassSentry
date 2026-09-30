import inquirer from "inquirer";

import { SESSION_STATUS } from "./api.js";

function pad(n) {
  return String(n).padStart(2, "0");
}

function formatStart(unixSec) {
  const d = new Date(Number(unixSec) * 1000);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function timeAgo(unixSec) {
  const diff = (Date.now() - Number(unixSec) * 1000) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} minutes ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hours ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} days ago`;
  if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))} months ago`;
  return `${Math.floor(diff / (86400 * 365))} years ago`;
}

export async function pickCourse(api) {
  const courses = await api.listCourses();
  const { id } = await inquirer.prompt({
    type: "list",
    name: "id",
    message: "选择课程:",
    loop: true,
    choices: [
      ...courses.map((c) => ({
        value: c.id,
        name: `${c.title} - ${c.teacher}`,
      })),
      {
        value: "__manual__",
        name: "手动输入课程 ID",
      },
    ],
  });
  if (id === "__manual__") {
    const { manual } = await inquirer.prompt({
      type: "input",
      name: "manual",
      message: "请输入课程 ID:",
    });
    const trimmed = String(manual).trim();
    return { id: trimmed, title: `课程 ${trimmed}`, teacher: "" };
  }
  const found = courses.find((c) => String(c.id) === String(id));
  return {
    id,
    title: found?.title || `课程 ${id}`,
    teacher: found?.teacher || "",
  };
}

function labelSession(session) {
  const status = SESSION_STATUS[session.status] || `状态${session.status}`;
  return `${session.title} (${formatStart(session.start_at)}) [${status}]`;
}

// mode="monitor": 直播中的排最前，其次未开始，已结束排后
// mode="replay": 只列已结束（status "6"），按开始时间倒序
export async function pickSession(sessions, { mode = "monitor" } = {}) {
  let list = [...sessions];
  if (mode === "replay") {
    list = list
      .filter((s) => s.status === "6")
      .sort((a, b) => Number(b.start_at) - Number(a.start_at));
    if (!list.length) {
      console.log("该课程没有已结束（有回放）的场次");
      return null;
    }
  } else {
    const rank = (s) => (s.status === "1" ? 0 : s.status === "2" ? 1 : 2);
    list.sort(
      (a, b) => rank(a) - rank(b) || Number(b.start_at) - Number(a.start_at)
    );
  }

  const { session } = await inquirer.prompt({
    type: "list",
    name: "session",
    message: "选择场次:",
    loop: true,
    choices: list.map((s) => ({ value: s, name: labelSession(s) })),
  });

  if (mode === "monitor" && session.status !== "1") {
    const status = SESSION_STATUS[session.status] || `状态${session.status}`;
    const { proceed } = await inquirer.prompt({
      type: "confirm",
      name: "proceed",
      message: `该场次当前${status}，不在直播中，仍要继续监控吗？`,
      default: false,
    });
    if (!proceed) return null;
  }
  return session;
}
