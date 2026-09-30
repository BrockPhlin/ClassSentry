import crypto from "node:crypto";

import { boldKeywords } from "./matcher.js";

// 钉钉自定义机器人 webhook 推送。
// 加签算法与 ZJU-live-better/shared/dingtalk-webhook.js 一致（官方文档已核对）：
// HMAC-SHA256(key=secret, msg="${毫秒时间戳}\n${secret}") -> base64 -> encodeURIComponent -> URL 追加
function signedUrl(webhook, secret) {
  if (!secret) return webhook;
  const timestamp = Date.now();
  const stringToSign = `${timestamp}\n${secret}`;
  const sign = crypto
    .createHmac("sha256", secret)
    .update(stringToSign)
    .digest("base64");
  const separator = webhook.includes("?") ? "&" : "?";
  return `${webhook}${separator}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
}

async function postMarkdown(config, title, text) {
  if (!config.enableDingtalk || !config.dingtalkWebhook) {
    return { sent: false, reason: "disabled" };
  }
  const response = await fetch(signedUrl(config.dingtalkWebhook, config.dingtalkSecret), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msgtype: "markdown", markdown: { title, text } }),
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });
  // 钉钉业务错误也返回 HTTP 200，必须检查 errcode（310000=安全校验失败等）
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  if (data.errcode) {
    throw new Error(data.errmsg || `errcode ${data.errcode}`);
  }
  return { sent: true };
}

export function createNotifier(config) {
  async function sendWithRetry(title, text) {
    try {
      return await postMarkdown(config, title, text);
    } catch (e) {
      console.error(`[钉钉] 发送失败：${e.message}，3 秒后重试一次`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return postMarkdown(config, title, text);
    }
  }

  return {
    async sendAlert({ courseLabel, sessionTitle, displayTime, hits, sentence }) {
      const title = config.alertTitle;
      const text = [
        `### ${title}`,
        `- **课程**：${courseLabel}`,
        `- **场次**：${sessionTitle}`,
        `- **时间**：${displayTime}`,
        `- **命中**：${hits.map((h) => `\`${h}\``).join("、")}`,
        "",
        `> 老师原话：${boldKeywords(sentence, hits)}`,
      ].join("\n");
      try {
        return await sendWithRetry(title, text);
      } catch (e) {
        // 告警失败不能炸掉监控循环
        console.error(`[钉钉] 重试后仍失败：${e.message}`);
        return { sent: false, reason: String(e.message || e) };
      }
    },

    // test-ding 子命令用：失败直接抛错，方便看到原因
    async sendTest() {
      if (!config.enableDingtalk || !config.dingtalkWebhook) {
        throw new Error(
          "钉钉未启用：请把 .env 中 ENABLE_DINGTALK 设为 true 并配置 DINGTALK_WEBHOOK"
        );
      }
      const text = [
        `### ${config.alertTitle}`,
        "",
        "这是一条 ClassSentry 测试消息，收到即说明钉钉链路正常。",
      ].join("\n");
      await postMarkdown(config, config.alertTitle, text);
    },
  };
}
