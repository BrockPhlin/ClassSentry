const COURSE_LIST_URL =
  "https://education.cmc.zju.edu.cn/personal/courseapi/vlabpassportapi/v1/account-profile/course?nowpage=1&per-page=100&force_mycourse=1";
const CATALOGUE_URL = "https://yjapi.cmc.zju.edu.cn/courseapi/v2/course/catalogue";
const LIVE_LIST_URL =
  "https://yjapi.cmc.zju.edu.cn/courseapi/v2/course-live/search-live-course-list";
const TRANS_RESULT_URL =
  "https://yjapi.cmc.zju.edu.cn/courseapi/v3/web-socket/search-trans-result";

// catalogue 条目 status 含义（官方前端 + 开源项目交叉验证）
export const SESSION_STATUS = {
  "1": "直播中",
  "2": "未开始",
  "3": "回放生成中",
  "4": "已结束",
  "5": "回放生成中",
  "6": "回放可看",
  "7": "回放",
};

function pad(n) {
  return String(n).padStart(2, "0");
}

function formatWallClock(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatIntoSession(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `开课第${pad(m)}:${pad(s)}`;
}

// 把 search-trans-result / ws 帧的两种形态归一化为统一 fragment。
// 课后形态：{BeginSec(相对开场的秒数), EndSec?, Text}
// 直播中形态（trans_type==="ai"）：{time(日期时间字符串), Text}
export function normaliseTransItem(item, { source, sessionStartMs = 0 } = {}) {
  const text = String(item?.Text ?? item?.text ?? "").trim();
  if (!text) return null;

  if (item?.BeginSec !== undefined && item?.BeginSec !== null && item?.BeginSec !== "") {
    const beginSec = Number(item.BeginSec);
    if (Number.isFinite(beginSec)) {
      const endSec = Number(item.EndSec);
      const anchor = sessionStartMs || 0;
      return {
        text,
        beginMs: anchor + beginSec * 1000,
        endMs:
          Number.isFinite(endSec) && endSec > 0 ? anchor + endSec * 1000 : 0,
        final: true,
        displayTime: formatIntoSession(beginSec),
        source,
        key: `b:${item.BeginSec}|${text}`,
      };
    }
  }

  const timeStr = item?.time ?? item?.Time;
  if (timeStr) {
    // V8 按本地时区解析，仅用于展示与排序
    const ms = Date.parse(String(timeStr).replace(" ", "T"));
    const beginMs = Number.isFinite(ms) ? ms : Date.now();
    return {
      text,
      beginMs,
      endMs: 0,
      final: true,
      displayTime: formatWallClock(beginMs),
      source,
      key: `t:${timeStr}|${text}`,
    };
  }

  const now = Date.now();
  return {
    text,
    beginMs: now,
    endMs: 0,
    final: true,
    displayTime: formatWallClock(now),
    source,
    key: `x:${now}|${text}`,
  };
}

export function createApi(classroom, config) {
  async function getJson(url, meta) {
    let res;
    try {
      res = await classroom.fetch(url, {
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
    } catch (e) {
      throw new Error(`${meta}请求失败：${e.message}`);
    }
    if (!res.ok) {
      throw new Error(`${meta}请求失败：HTTP ${res.status}`);
    }
    const data = await res.json().catch(() => {
      throw new Error(`${meta}返回非 JSON，登录可能已失效，请重启程序重试`);
    });
    return data;
  }

  return {
    // 我的智云课程列表 → [{id, title, teacher}]
    async listCourses() {
      const data = await getJson(COURSE_LIST_URL, "课程列表");
      const rows = data?.params?.result?.data;
      if (!Array.isArray(rows)) {
        throw new Error("课程列表结构异常，登录可能已失效，请重启程序重试");
      }
      return rows.map((c) => ({
        id: c.Id,
        title: c.Title ?? `课程 ${c.Id}`,
        teacher: c.Teacher ?? "",
      }));
    },

    // 场次目录 → 原始条目数组（含 course_id, sub_id, title, status, start_at）
    async listCatalogue(courseId) {
      const data = await getJson(
        `${CATALOGUE_URL}?course_id=${encodeURIComponent(courseId)}`,
        "场次目录"
      );
      const rows = data?.result?.data;
      if (!Array.isArray(rows)) {
        throw new Error("场次目录结构异常");
      }
      return rows;
    },

    // 直播状态与 ASR 能力探测
    async searchLive(courseId, subId) {
      const params = new URLSearchParams({
        all: "1",
        course_id: String(courseId),
        sub_id: String(subId),
        with_sub_data: "1",
        with_room_data: "1",
        show_all: "1",
      });
      const data = await getJson(`${LIVE_LIST_URL}?${params.toString()}`, "直播信息");
      const entry = data?.list?.[0] || {};
      let subContent = {};
      if (entry.sub_content) {
        try {
          subContent =
            typeof entry.sub_content === "string"
              ? JSON.parse(entry.sub_content)
              : entry.sub_content;
        } catch {
          subContent = {};
        }
      }
      const transSocketUrl = subContent.trans_socket_url || "";
      const qliteStatus = subContent?.api_pass?.qlite_status || "";
      return {
        live: Number(entry.sub_status) === 1,
        subStatus: entry.sub_status,
        hasAsr: Boolean(transSocketUrl),
        asrRunning: qliteStatus === "running",
        transSocketUrl,
      };
    },

    // 转写结果 → { finished, items: fragment[] }。finished=已切换到课后 BeginSec 形态
    async fetchTransResult(subId, { sessionStartMs = 0, source = "poll" } = {}) {
      const params = new URLSearchParams({
        sub_id: String(subId),
        format: "json",
      });
      const data = await getJson(`${TRANS_RESULT_URL}?${params.toString()}`, "转写结果");
      if (data?.code !== 0) {
        throw new Error(`转写结果接口返回 code=${data?.code}`);
      }
      const first = Array.isArray(data?.list) ? data.list[0] : null;
      const rawItems = Array.isArray(first?.all_content) ? first.all_content : [];
      const finished = Boolean(
        first && rawItems.length > 0 && rawItems[0].BeginSec !== undefined
      );
      const items = rawItems
        .map((item) => normaliseTransItem(item, { source, sessionStartMs }))
        .filter(Boolean);
      return { finished, items };
    },
  };
}
