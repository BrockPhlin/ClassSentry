import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewer } from '../review.js';
import { createPipeline } from '../pipeline.js';

// LLM_REVIEW 关闭时不创建复核器，pipeline 链路与原行为完全一致
test('reviewer：未开启 LLM_REVIEW 时为 null', () => {
  assert.equal(createReviewer({ llmReview: false }), null);
});

// 模拟 Anthropic 客户端：按脚本返回响应
function fakeClient(script) {
  return {
    messages: {
      async create() {
        const step = script.shift();
        if (step.error) throw step.error;
        return step.response;
      },
    },
  };
}

test('reviewer：判定误报返回 push=false', async () => {
  const reviewer = createReviewer({ llmReview: true, llmModel: 'test' }, fakeClient([
    { response: { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"push": false, "reason": "同音误转"}' }] } },
  ]));
  const verdict = await reviewer.review({ hits: ['签到'], sentence: '请大家请到一下' });
  assert.equal(verdict.push, false);
  assert.equal(verdict.reason, '同音误转');
});

test('reviewer：确认是真的号召返回 push=true', async () => {
  const reviewer = createReviewer({ llmReview: true, llmModel: 'test' }, fakeClient([
    { response: { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"push": true, "reason": "发起签到"}' }] } },
  ]));
  assert.equal((await reviewer.review({ hits: ['签到'], sentence: '现在开始签到' })).push, true);
});

test('reviewer：JSON 解析失败 / API 出错时放行（fail-open）', async () => {
  const badJson = createReviewer({ llmReview: true }, fakeClient([
    { response: { stop_reason: 'end_turn', content: [{ type: 'text', text: '我觉得是误报' }] } },
  ]));
  const verdict = await badJson.review({ hits: ['签到'], sentence: 'x' });
  assert.equal(verdict.push, true);
  assert.ok(verdict.reason.includes('复核失败放行'));

  const apiError = createReviewer({ llmReview: true }, fakeClient([
    { error: new Error('network down') },
  ]));
  assert.equal((await apiError.review({ hits: ['签到'], sentence: 'x' })).push, true);
});

// ---------- pipeline 集成：拦截 / 放行 ----------

const PIPELINE_CONFIG = {
  keywords: ['签到'],
  keywordCooldownMs: 60_000,
  alertOnFinalOnly: false,
  alertTitle: '【测试】',
  enableDingtalk: false,
  dingtalkWebhook: '',
  requestTimeoutMs: 1000,
};

function makeSink() {
  const calls = [];
  return {
    calls,
    fragment() {},
    endInterim() {},
    alert(hits) { calls.push(['alert', hits]); },
    notice(text) { calls.push(['notice', text]); },
  };
}

function fragmentOf(text) {
  return { key: text, text, final: true, displayTime: '00:01' };
}

test('pipeline：LLM 判定误报时不推送，历史记「误报拦截」', async () => {
  const sink = makeSink();
  const alerts = [];
  const reviewer = { async review() { return { push: false, reason: '同音误转' }; } };
  const pipeline = createPipeline(
    { ...PIPELINE_CONFIG, llmReview: true },
    { courseLabel: '课程', onAlert: (a) => alerts.push(a) },
    sink,
    { reviewer },
  );
  await pipeline.ingest(fragmentOf('听说签到率不高，大家注意'));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].reason, 'llm_filtered');
  assert.equal(alerts[0].sent, false);
  assert.equal(pipeline.stats.filtered, 1);
  assert.ok(sink.calls.some(([kind, text]) => kind === 'notice' && text.includes('未推送')), '控制台应有拦截旁注');
});

test('pipeline：LLM 放行走原有推送链路', async () => {
  const sink = makeSink();
  const alerts = [];
  const reviewer = { async review() { return { push: true, reason: '发起签到' }; } };
  const pipeline = createPipeline(
    { ...PIPELINE_CONFIG, llmReview: true },
    { courseLabel: '课程', onAlert: (a) => alerts.push(a) },
    sink,
    { reviewer },
  );
  await pipeline.ingest(fragmentOf('现在开始签到'));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].reason, 'disabled', '钉钉未启用时保持原有「未启用」语义');
  assert.equal(pipeline.stats.filtered, 0);
});

test('pipeline：未开启复核时行为与原来一致', async () => {
  const sink = makeSink();
  const alerts = [];
  const pipeline = createPipeline(
    { ...PIPELINE_CONFIG },
    { courseLabel: '课程', onAlert: (a) => alerts.push(a) },
    sink,
  );
  await pipeline.ingest(fragmentOf('现在开始签到'));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].reason, 'disabled');
  assert.equal(pipeline.stats.filtered, 0);
});
