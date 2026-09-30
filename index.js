#!/usr/bin/env node

/* 智云课堂实时语音关键词预警
 *
 * 监听智云课堂直播的平台实时语音识别转写，老师说到「签到」「小测」等关键词时
 * 通过钉钉机器人实时推送预警。使用平台自带的识别结果，不自建 ASR。
 *
 * 使用方法：
 *   node index.js             # 选课 -> 选直播场次 -> 开始监控（默认）
 *   node index.js replay      # 重放一场已结束课程的转写，验证告警链路
 *   node index.js test-ding   # 发送钉钉测试消息
 *   node index.js help        # 显示帮助
 *
 * 配置见 .env.example。实时通道为平台的 glue WebSocket；无实时字幕通道时
 * 自动降级为轮询 search-trans-result（延迟未知）。
 */

import "dotenv/config";

import inquirer from "inquirer";
import { CLASSROOM, ZJUAM } from "login-zju";

import { createApi } from "./api.js";
import { buildConfig, ensureCredentials } from "./config.js";
import { createSessionListener } from "./listen.js";
import { PollListener } from "./listeners/poll.js";
import { createNotifier } from "./notify.js";
import { createPipeline, printStats } from "./pipeline.js";
import { pickCourse, pickSession } from "./select.js";

function printHelp() {
  console.log(`用法：node index.js [command]

命令：
  (无)        监控选定的直播场次，命中关键词实时推送钉钉（默认）
  replay      重放一场已结束课程的转写，验证告警链路
  test-ding   发送一条钉钉测试消息
  help        显示本帮助

配置：复制 .env.example 为 .env 并填写，详见 .env.example 内注释。`);
}

// 转写监听事件 -> 控制台状态行
function wireListener(listener, pipeline) {
  listener.on("fragment", (fragment) => {
    pipeline.ingest(fragment).catch((e) => {
      console.error(`处理转写失败：${e.message}`);
    });
  });
  listener.on("status", (msg) => {
    pipeline.newlineIfInterim();
    console.log(`-- ${msg}`);
  });
  listener.on("error", (err) => {
    pipeline.newlineIfInterim();
    console.error(`!! ${err.message}`);
  });
}

function finish(pipeline) {
  printStats(pipeline.stats, "\n本场直播结束。");
  process.exit(0);
}

async function runMonitor(config, api) {
  const course = await pickCourse(api);
  const catalogue = await api.listCatalogue(course.id);
  const session = await pickSession(catalogue, { mode: "monitor" });
  if (!session) {
    console.log("已取消");
    return;
  }

  const sessionStartMs = Number(session.start_at) * 1000;
  const courseLabel = course.teacher
    ? `${course.title}（${course.teacher}）`
    : course.title;
  const sessionTitle = session.title;
  console.log(`课程：${courseLabel}`);
  console.log(`场次：${sessionTitle}（sub_id=${session.sub_id}）`);

  // 探测直播状态与平台 ASR 能力
  let probe = { live: false, hasAsr: false, asrRunning: false, transSocketUrl: "" };
  try {
    probe = await api.searchLive(session.course_id ?? course.id, session.sub_id);
  } catch (e) {
    console.warn(`探测直播状态失败：${e.message}`);
  }
  console.log(
    `直播状态：${probe.live ? "直播中" : "未在直播"} / ASR 通道：${probe.hasAsr ? "有" : "无"} / ASR 运行：${probe.asrRunning ? "是" : "否"}`
  );

  const pipeline = createPipeline(config, { courseLabel, sessionTitle });

  const listenerCtl = createSessionListener({
    config,
    apiRef: { current: api },
    course,
    session,
    probe,
    pipeline,
    log: (msg, level = "info") => {
      pipeline.newlineIfInterim();
      if (level === "warn") console.warn(`>> ${msg}`);
      else if (level === "error") console.error(`!! ${msg}`);
      else console.log(`-- ${msg}`);
    },
    onEnded: () => finish(pipeline),
  });

  listenerCtl.start();

  process.on("SIGINT", () => {
    listenerCtl.stop();
    printStats(pipeline.stats, "\n手动退出。");
    process.exit(0);
  });
}

async function runReplay(config, api) {
  const course = await pickCourse(api);
  const catalogue = await api.listCatalogue(course.id);
  const session = await pickSession(catalogue, { mode: "replay" });
  if (!session) return;

  const sessionStartMs = Number(session.start_at) * 1000;
  const courseLabel = course.teacher
    ? `${course.title}（${course.teacher}）`
    : course.title;
  const sessionTitle = session.title;
  console.log(`重放：${courseLabel} - ${sessionTitle}（sub_id=${session.sub_id}）`);

  if (config.enableDingtalk) {
    const { proceed } = await inquirer.prompt({
      type: "confirm",
      name: "proceed",
      message: "将按历史转写推送告警到钉钉（每词最多一条，受冷却限制），继续？",
      default: true,
    });
    if (!proceed) {
      console.log("已取消");
      return;
    }
  } else {
    console.warn(">> 钉钉未启用，本次重放仅在控制台显示告警");
  }

  const pipeline = createPipeline(config, { courseLabel, sessionTitle });
  const listener = new PollListener({
    fetchItems: () =>
      api.fetchTransResult(session.sub_id, { sessionStartMs, source: "replay" }),
    intervalMs: config.pollIntervalMs,
    alertOnBaseline: true,
  });
  wireListener(listener, pipeline);
  listener.on("ended", () => finish(pipeline));
  await listener.start();

  process.on("SIGINT", () => {
    listener.stop();
    printStats(pipeline.stats, "\n手动退出。");
    process.exit(0);
  });
}

async function main() {
  const command = process.argv[2] || "monitor";
  const config = buildConfig();

  if (command === "help" || command === "-h" || command === "--help") {
    printHelp();
    return;
  }

  if (command === "test-ding") {
    const notifier = createNotifier(config);
    await notifier.sendTest();
    console.log("测试消息已发送，请到钉钉群确认收到。");
    return;
  }

  ensureCredentials(config);
  const classroom = new CLASSROOM(new ZJUAM(config.username, config.password));
  const api = createApi(classroom, config);

  if (command === "replay") {
    await runReplay(config, api);
    return;
  }
  if (command === "monitor") {
    await runMonitor(config, api);
    return;
  }
  printHelp();
}

main().catch((e) => {
  console.error(`出错了：${e.message}`);
  process.exit(1);
});
