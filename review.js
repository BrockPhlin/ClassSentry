import Anthropic from "@anthropic-ai/sdk";

// LLM 误报复核（可选，LLM_REVIEW 开启时生效）：
// 命中关键词后先让 Claude 判断这句话是否真的是老师在号召/宣布，
// 判定为误报则跳过钉钉推送。复核失败一律放行（fail-open），
// 保证 LLM 不可用时告警链路与传统行为完全一致。

const REVIEW_TIMEOUT_MS = 8000;

// client 仅测试注入用；生产路径不传，由 SDK 从环境解析凭据
export function createReviewer(config, client = null) {
  if (!config.llmReview) return null;
  const anthropic = client ?? new Anthropic();

  async function review({ hits, sentence }) {
    const response = await anthropic.messages.create(
      {
        model: config.llmModel || "claude-haiku-4-5",
        max_tokens: 512,
        system:
          "你是课堂预警系统的一审员。课堂直播转写里命中了预警关键词，" +
          "但语音识别常有同音字误转（如「请到」转成「签到」），你需要判断老师这句话" +
          "是否真的在号召/宣布学生做对应的事（签到、扫码、小测、点名等）。" +
          "只输出一行 JSON：{\"push\": true 或 false, \"reason\": \"不超过 15 字的理由\"}",
        messages: [
          {
            role: "user",
            content: `命中关键词：${hits.join("、")}\n老师原话：「${sentence}」`,
          },
        ],
      },
      { timeout: REVIEW_TIMEOUT_MS },
    );

    if (response.stop_reason !== "end_turn") {
      throw new Error(`LLM 未正常结束（${response.stop_reason}）`);
    }
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    const match = text.match(/\{[^]*\}/);
    if (!match) throw new Error(`LLM 输出里没有 JSON：${text.slice(0, 80)}`);
    const verdict = JSON.parse(match[0]);
    if (typeof verdict.push !== "boolean") {
      throw new Error(`LLM 输出格式不对：${text.slice(0, 80)}`);
    }
    return { push: verdict.push, reason: String(verdict.reason || "") };
  }

  // 永不抛错：失败放行并给出原因，由调用方记日志
  return {
    async review(args) {
      try {
        return await review(args);
      } catch (e) {
        return { push: true, reason: `复核失败放行：${String(e.message || e)}` };
      }
    },
  };
}
