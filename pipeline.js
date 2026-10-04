import { createMatcher, highlight } from "./matcher.js";
import { createNotifier } from "./notify.js";
import { createReviewer } from "./review.js";

// 渲染 sink：pipeline 只产生语义事件，呈现完全委托给 sink。
// 契约（4 方法）：
//   fragment(f)    渲染一行转写；f.final=false 为 interim（覆盖当前行）
//   endInterim()   把挂着的 interim 行落定（控制台=补换行；Web=广播 flush）
//   alert(hits)    渲染命中行（pipeline 保证已先调 endInterim）
//   notice(text)   旁注（如"钉钉未启用，仅控制台告警"）
export function createConsoleSink(config) {
  let interimLine = false; // 当前是否有一行未完成的 interim 转写挂在 stdout

  return {
    fragment(fragment) {
      const line = `[${fragment.displayTime}] ${highlight(fragment.text, config.keywords)}${fragment.final ? "" : " …"}`;
      if (fragment.final) {
        if (interimLine) process.stdout.write("\n");
        interimLine = false;
        console.log(line);
      } else {
        process.stdout.write(`\r\x1b[K${line}`);
        interimLine = true;
      }
    },
    endInterim() {
      if (interimLine) {
        process.stdout.write("\n");
        interimLine = false;
      }
    },
    alert(hits) {
      console.log(`\x1b[32m>>> 命中关键词：${hits.join("、")}\x1b[0m`);
    },
    notice(text) {
      console.warn(text);
    },
  };
}

// 转写管道：去重 -> 渲染(sink) -> 关键词匹配 -> 钉钉告警。
// context: { courseLabel, sessionTitle, onAlert?({fragment, hits, sent, reason, at}) }
// deps.reviewer 仅测试注入用；生产路径按 config.llmReview 自动创建
export function createPipeline(config, context = {}, sink = null, deps = {}) {
  const theSink = sink ?? createConsoleSink(config);
  const matcher = createMatcher({
    keywords: config.keywords,
    cooldownMs: config.keywordCooldownMs,
  });
  const notifier = createNotifier(config);
  const reviewer = deps.reviewer ?? createReviewer(config); // LLM_REVIEW 关闭时为 null，链路与原来完全一致
  const seen = new Set();
  const stats = { fragments: 0, alerts: 0, filtered: 0 };

  // opts.record: 是否去重登记；opts.silent: 只登记不渲染不匹配（WS 首连补齐历史用）
  async function ingest(fragment, opts = {}) {
    const { record = true, silent = false } = opts;
    if (record) {
      if (seen.has(fragment.key)) return;
      seen.add(fragment.key);
    }
    stats.fragments += 1;
    if (silent) return;

    theSink.fragment(fragment);
    if (config.alertOnFinalOnly && !fragment.final) return;

    const hits = matcher.feed(fragment);
    if (!hits.length) return;

    stats.alerts += 1;
    theSink.endInterim();
    theSink.alert(hits);

    // LLM 复核（可选）：判定为误报则不推钉钉，历史里记「误报拦截」
    let verdict = null;
    if (reviewer) {
      verdict = await reviewer.review({ hits, sentence: fragment.text });
      if (!verdict.push) {
        stats.filtered += 1;
        theSink.notice(`（LLM 判定为误报，未推送：${verdict.reason}）`);
        context.onAlert?.({
          fragment,
          hits,
          sent: false,
          reason: "llm_filtered",
          at: Date.now(),
        });
        return;
      }
    }

    const result = await notifier.sendAlert({
      courseLabel: context.courseLabel,
      sessionTitle: context.sessionTitle,
      displayTime: fragment.displayTime,
      hits,
      sentence: fragment.text,
    });
    context.onAlert?.({
      fragment,
      hits,
      sent: result.sent,
      reason: result.reason ?? null,
      at: Date.now(),
    });
    if (!result.sent && result.reason === "disabled") {
      theSink.notice("（钉钉未启用，仅控制台告警）");
    }
  }

  return {
    ingest,
    stats,
    newlineIfInterim() {
      theSink.endInterim();
    },
  };
}

export function printStats(stats, prefix = "") {
  let line = `${prefix}共接收 ${stats.fragments} 条转写，触发 ${stats.alerts} 次告警`;
  if (stats.filtered) line += `，LLM 拦截 ${stats.filtered} 条误报`;
  console.log(line);
}
