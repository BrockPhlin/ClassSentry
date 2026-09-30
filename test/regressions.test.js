import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createMonitor } from '../monitor.js';
import { PollListener } from '../listeners/poll.js';
import { compileKeywords } from '../matcher.js';
import { toSafeSettings } from '../settings.js';

const config = {
  username: '', password: '', keywords: ['签到'], keywordCooldownMs: 120000,
  enableDingtalk: false, listenMode: 'poll', pollIntervalMs: 100000,
  requestTimeoutMs: 1000, alertOnFinalOnly: false,
};
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
function fixture(t, api, cfg = config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'class-sentry-test-'));
  const monitor = createMonitor({ getConfig: () => cfg, historyPath: path.join(dir, 'alerts.json'), apiFactory: typeof api === 'function' ? api : () => api });
  t.after(() => { monitor.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return monitor;
}
const task = { mode: 'monitor', course: { id: '1', title: '测试课程' }, session: { subId: '2', title: '第一课' } };

test('停止启动中的任务后，探测返回不会重新开启监听', async t => {
  const probe = deferred();
  let fetches = 0;
  const monitor = fixture(t, { searchLive: () => probe.promise, fetchTransResult: async () => { fetches++; return { items: [] }; } });
  const starting = monitor.start(task);
  await Promise.resolve();
  assert.equal(monitor.getState().phase, 'starting');
  monitor.stop();
  probe.resolve({ live: true, hasAsr: false });
  await starting;
  assert.equal(monitor.getState().phase, 'stopped');
  assert.equal(fetches, 0);
});

test('直播轮询使用有效 API', async t => {
  const fetched = deferred();
  const monitor = fixture(t, {
    searchLive: async () => ({ live: true, hasAsr: false }),
    fetchTransResult: async () => { fetched.resolve(); return { items: [] }; },
  });
  await monitor.start(task);
  await fetched.promise;
  assert.equal(monitor.getState().listenerKind, 'poll');
  assert.equal(monitor.getState().phase, 'running');
});

test('轮询请求不重叠；停止后丢弃尚未返回的数据', async () => {
  const response = deferred();
  let calls = 0;
  let fragments = 0;
  const listener = new PollListener({ fetchItems: () => { calls++; return response.promise; }, intervalMs: 1000 });
  listener.on('fragment', () => fragments++);
  const first = listener.poll(false);
  await listener.poll(false);
  assert.equal(calls, 1);
  listener.stop();
  response.resolve({ items: [{ key: 'a', text: '签到' }] });
  await first;
  assert.equal(fragments, 0);
});

test('场次结束后停止定时轮询', async () => {
  const listener = new PollListener({ fetchItems: async () => ({ items: [], finished: true }), intervalMs: 1000 });
  const ended = once(listener, 'ended');
  listener.start();
  await ended;
  assert.equal(listener.stopped, true);
  assert.equal(listener.timer, null);
});

test('中英文逗号分隔关键词，并清除重复项', () => {
  assert.deepEqual(compileKeywords('签到，扫码,签到, QUIZ'), ['签到', '扫码', 'quiz']);
});

test('设置视图隐藏包括短 token 在内的 Webhook 参数', () => {
  const settings = toSafeSettings({ ...config, dingtalkWebhook: 'https://user:pass@example.com/send?access_token=abc&secret=hidden' });
  assert.ok(!settings.dingtalk.webhook.includes('abc'));
  assert.ok(!settings.dingtalk.webhook.includes('hidden'));
  assert.ok(!settings.dingtalk.webhook.includes('user'));
  assert.ok(!settings.dingtalk.webhook.includes('pass'));
  assert.equal(settings.hasPassword, false);
});


test('重新登录后，运行中的监听器切换到新的 API', { timeout: 2000 }, async t => {
  let generation = 0;
  const firstPoll = deferred();
  const nextPoll = deferred();
  const monitor = fixture(t, () => {
    const id = ++generation;
    return {
      listCourses: async () => [],
      searchLive: async () => ({ live: true, hasAsr: false }),
      fetchTransResult: async () => {
        (id === 1 ? firstPoll : nextPoll).resolve(id);
        return { items: [] };
      },
    };
  }, { ...config, pollIntervalMs: 5 });
  await monitor.start(task);
  assert.equal(await firstPoll.promise, 1);
  await monitor.loginTest();
  assert.equal(await nextPoll.promise, 2);
});

