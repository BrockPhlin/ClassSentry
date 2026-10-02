import test from 'node:test';
import assert from 'node:assert/strict';
import { createCheckin } from '../checkin.js';
import { haversineMeters, solveSphereLeastSquares, R_EARTH } from '../geo.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 3000, step = 5) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (fn()) return;
    await sleep(step);
  }
  throw new Error('waitFor 超时');
}

const DEFAULT_AT = process.env.CHECKIN_RADAR_AT || 'YQ1';

const cfg = { username: 'u', password: 'p' };

// 假 courses 会话：fetch 按 route 分发；统计工厂调用次数与 PUT 次数
function fixture(t, route, { pollMs = 10, idleStopMs = 60000 } = {}) {
  let putCount = 0;
  const factoryCalls = [];
  const coursesFactory = (c) => {
    const courses = { sessionIndex: factoryCalls.length + 1 };
    courses.fetch = async (url, init = {}) => {
      if ((init.method || 'GET') === 'PUT') putCount += 1;
      return route(courses, url, init, c);
    };
    factoryCalls.push(courses);
    return courses;
  };
  const checkin = createCheckin({ getConfig: () => cfg, coursesFactory, pollMs, idleStopMs });
  t.after(() => checkin.stop());
  return { checkin, factoryCalls, puts: () => putCount };
}

const ok = (body, status = 200) => ({ status, json: async () => body });
const rollcall = (over = {}) => ({
  rollcall_id: 101,
  course_title: '测试课程',
  title: '点名一',
  is_radar: true,
  is_number: false,
  is_expired: false,
  rollcall_status: 'in_progress',
  status: 'absent',
  ...over,
});

test('geo：球面最小二乘可从距离恢复信号源坐标', () => {
  const truth = { lon: 120.1, lat: 30.28 };
  const beacons = [
    [truth.lon + 0.01, truth.lat + 0.01],
    [truth.lon - 0.012, truth.lat + 0.008],
    [truth.lon + 0.009, truth.lat - 0.011],
    [truth.lon - 0.007, truth.lat - 0.009],
  ];
  const exact = beacons.map(([lon, lat]) => ({
    lon, lat, d: haversineMeters(truth.lon, truth.lat, lon, lat),
  }));
  const est = solveSphereLeastSquares(exact);
  assert.ok(Math.abs(est.lon - truth.lon) < 1e-5, `经度偏差 ${Math.abs(est.lon - truth.lon)}`);
  assert.ok(Math.abs(est.lat - truth.lat) < 1e-5, `纬度偏差 ${Math.abs(est.lat - truth.lat)}`);
  assert.ok(est.rms < 1);

  // 米级噪声下仍应落在 500m 判定半径的远冗余之内
  const noise = [3, -4, 2, -1];
  const noisy = exact.map((p, i) => ({ ...p, d: p.d + noise[i] }));
  const est2 = solveSphereLeastSquares(noisy);
  assert.ok(haversineMeters(est2.lon, est2.lat, truth.lon, truth.lat) < 50);

  // 退化输入
  const bad = solveSphereLeastSquares([{ lon: 120, lat: 30, d: 100 }, { lon: 120, lat: 30, d: 100 }]);
  assert.ok(Number.isNaN(bad.lon) && Number.isNaN(bad.lat));
  assert.equal(R_EARTH, 6372999.26);
});

test('radar：首个信标成功；已答到的点名后续轮询不再提交', async (t) => {
  const { checkin, puts } = fixture(t, (courses, url, init) => {
    if (url.endsWith('/api/radar/rollcalls')) return ok({ rollcalls: [rollcall()] });
    if (url.includes('/answer?')) return ok({ status_name: 'on_call_fine' });
    return ok({});
  });
  await checkin.start();
  await waitFor(() => checkin.getState().results[0]?.outcome === 'success');
  assert.equal(checkin.getState().stats.answered, 1);
  assert.equal(checkin.getState().results[0].detail, DEFAULT_AT);
  assert.equal(puts(), 1);

  // 列表继续返回同一场点名（已 on_call），不应再提交
  await sleep(40);
  assert.equal(puts(), 1);
});

test('radar：所有信标超距时走三边定位路径', async (t) => {
  const truth = { lon: 120.1, lat: 30.28 };
  let successBody = null;
  const { checkin } = fixture(t, (courses, url, init) => {
    if (url.endsWith('/api/radar/rollcalls')) return ok({ rollcalls: [rollcall()] });
    if (url.includes('/answer?')) {
      const body = JSON.parse(init.body);
      const d = haversineMeters(body.longitude, body.latitude, truth.lon, truth.lat);
      if (d <= 500 && !successBody) successBody = body;
      return ok({ status_name: d <= 500 ? 'on_call_fine' : 'radar_out_of_scope', distance: Math.round(d) });
    }
    return ok({});
  });
  await checkin.start();
  await waitFor(() => checkin.getState().results[0]?.outcome === 'success');
  assert.ok(successBody, '应有按估算坐标提交成功的请求');
  assert.ok(checkin.getState().results[0].detail.startsWith('估算坐标'));
  assert.ok(Math.abs(successBody.longitude - truth.lon) < 1e-3);
  assert.ok(Math.abs(successBody.latitude - truth.lat) < 1e-3);
});

test('radar：失败无距离信息时按轮数封顶', async (t) => {
  const { checkin, puts } = fixture(t, (courses, url) => {
    if (url.endsWith('/api/radar/rollcalls')) return ok({ rollcalls: [rollcall()] });
    if (url.includes('/answer?')) return ok({ status_name: 'radar_out_of_scope' });
    return ok({});
  });
  await checkin.start();
  await waitFor(() => checkin.getState().results[0]?.outcome === 'failed');
  // 每轮 12 个信标点位 × 5 轮
  assert.equal(puts(), 60);
  await sleep(40);
  assert.equal(puts(), 60, '封顶后不再提交');
});

test('number：直接取到口令一次提交成功', async (t) => {
  const { checkin, puts } = fixture(t, (courses, url, init) => {
    if (url.endsWith('/api/radar/rollcalls')) {
      return ok({ rollcalls: [rollcall({ is_radar: false, is_number: true, rollcall_id: 202 })] });
    }
    if (url.endsWith('/student_rollcalls')) return ok({ number_code: '1337' });
    if (url.endsWith('/answer_number_rollcall')) {
      const body = JSON.parse(init.body);
      return body.numberCode === '1337' ? ok({ id: 1, status: 'on_call' }) : ok({ error_code: 'wrong_number_code' }, 400);
    }
    return ok({});
  });
  await checkin.start();
  await waitFor(() => checkin.getState().results[0]?.outcome === 'success');
  assert.equal(puts(), 1);
  assert.equal(checkin.getState().results[0].detail, '口令 1337');
});

test('number：直接口令失败后穷举并在命中时提前收兵', async (t) => {
  const { checkin, puts } = fixture(t, (courses, url, init) => {
    if (url.endsWith('/api/radar/rollcalls')) {
      return ok({ rollcalls: [rollcall({ is_radar: false, is_number: true, rollcall_id: 203 })] });
    }
    if (url.endsWith('/student_rollcalls')) return ok({});
    if (url.endsWith('/answer_number_rollcall')) {
      const body = JSON.parse(init.body);
      return body.numberCode === '0005' ? ok({ id: 1, status: 'on_call' }) : ok({ error_code: 'wrong_number_code' }, 400);
    }
    return ok({});
  });
  await checkin.start();
  await waitFor(() => checkin.getState().results[0]?.outcome === 'success');
  assert.equal(checkin.getState().results[0].detail, '口令 0005');
  // 第一批 0000-0199 全部并发发出（200 个），命中后不再发后续批次
  assert.equal(puts(), 200);
  await sleep(40);
  assert.equal(puts(), 200, '下次轮询不重扫');
});

test('number：穷举全部失败则判失败且不重扫', async (t) => {
  const { checkin, puts } = fixture(t, (courses, url, init) => {
    if (url.endsWith('/api/radar/rollcalls')) {
      return ok({ rollcalls: [rollcall({ is_radar: false, is_number: true, rollcall_id: 204 })] });
    }
    if (url.endsWith('/student_rollcalls')) return ok({});
    if (url.endsWith('/answer_number_rollcall')) return ok({ error_code: 'wrong_number_code' }, 400);
    return ok({});
  });
  await checkin.start();
  await waitFor(() => checkin.getState().results[0]?.outcome === 'failed', 10000);
  assert.equal(puts(), 10000);
  assert.equal(checkin.getState().results[0].detail, '未找到有效口令');
  await sleep(40);
  assert.equal(puts(), 10000, '不重扫');
});

test('已答/过期/非进行中的点名跳过；未知类型记 unsupported', async (t) => {
  const { checkin, puts } = fixture(t, (courses, url) => {
    if (url.endsWith('/api/radar/rollcalls')) {
      return ok({
        rollcalls: [
          rollcall({ rollcall_id: 1, status: 'on_call_fine' }),
          rollcall({ rollcall_id: 2, is_expired: true }),
          rollcall({ rollcall_id: 3, rollcall_status: 'ended' }),
          rollcall({ rollcall_id: 4, is_radar: false, is_number: false }),
        ],
      });
    }
    return ok({ status_name: 'on_call_fine' });
  });
  await checkin.start();
  await waitFor(() => checkin.getState().results.some((r) => r.outcome === 'unsupported'));
  assert.equal(puts(), 0);
  const entry = checkin.getState().results.find((r) => r.rollcallId === 4);
  assert.equal(entry.outcome, 'unsupported');
  assert.ok(!checkin.getState().results.some((r) => [1, 2, 3].includes(r.rollcallId)), '已答/过期不进结果表');
});

test('轮询等待中停止：不再派发任何应答', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { checkin } = fixture(t, async (courses, url) => {
    if (url.endsWith('/api/radar/rollcalls')) {
      await gate;
      return ok({ rollcalls: [rollcall()] });
    }
    return ok({ status_name: 'on_call_fine' });
  });
  const starting = checkin.start();
  await waitFor(() => true);
  const state = checkin.stop();
  release();
  await assert.doesNotReject(() => starting);
  assert.equal(state.phase, 'stopped');
  assert.equal(checkin.getState().results.length, 0);
});

test('穷举进行中停止：提交数停止增长', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { checkin, puts } = fixture(t, async (courses, url, init) => {
    if (url.endsWith('/api/radar/rollcalls')) return ok({ rollcalls: [rollcall({ is_radar: false, is_number: true, rollcall_id: 205 })] });
    if (url.endsWith('/student_rollcalls')) return ok({});
    if (url.endsWith('/answer_number_rollcall')) {
      await gate;
      return ok({ error_code: 'wrong_number_code' }, 400);
    }
    return ok({});
  });
  checkin.start();
  await waitFor(() => puts() >= 200);
  checkin.stop();
  release();
  await sleep(40);
  assert.equal(checkin.getState().phase, 'stopped');
  assert.equal(puts(), 200);
});

test('markSessionDirty 后下一轮询重建会话并继续', async (t) => {
  let listing = [rollcall({ rollcall_id: 7 })];
  const { checkin, factoryCalls } = fixture(t, (courses, url) => {
    if (url.endsWith('/api/radar/rollcalls')) return ok({ rollcalls: listing });
    if (url.includes('/answer?')) return ok({ status_name: 'on_call_fine' });
    return ok({});
  });
  await checkin.start();
  await waitFor(() => checkin.getState().stats.answered === 1);
  checkin.markSessionDirty();
  listing = [rollcall({ rollcall_id: 8 })];
  await waitFor(() => checkin.getState().stats.answered === 2);
  assert.equal(factoryCalls.length, 2);
  await sleep(40);
  assert.equal(factoryCalls.length, 2, '无更多重建');
});

test('会话过期（401）自动重登一次并成功', async (t) => {
  const { checkin, factoryCalls } = fixture(t, (courses, url) => {
    if (courses.sessionIndex === 1) return ok({}, 401);
    if (url.endsWith('/api/radar/rollcalls')) return ok({ rollcalls: [rollcall()] });
    if (url.includes('/answer?')) return ok({ status_name: 'on_call_fine' });
    return ok({});
  });
  await checkin.start();
  await waitFor(() => checkin.getState().stats.answered === 1);
  assert.equal(factoryCalls.length, 2);
});

test('长时间无点名自动停止', async (t) => {
  const { checkin } = fixture(t, (courses, url) => ok({ rollcalls: [] }), { pollMs: 10, idleStopMs: 50 });
  await checkin.start();
  await waitFor(() => checkin.getState().phase === 'stopped');
  assert.equal(checkin.getState().stopReason, 'idle');
});

test('连续失败达到上限自动停止', async (t) => {
  let calls = 0;
  const { checkin } = fixture(t, async (courses, url) => {
    if (url.endsWith('/api/radar/rollcalls')) {
      calls += 1;
      if (calls === 1) return ok({ rollcalls: [] }); // 首轮成功让 start 正常进入 running
      throw new Error('网络不可用');
    }
    return ok({});
  });
  await checkin.start();
  await waitFor(() => checkin.getState().phase === 'stopped', 5000);
  const state = checkin.getState();
  assert.equal(state.stopReason, 'errors');
  assert.ok(state.lastError.includes('网络不可用'));
});

test('未配置凭据时拒绝启动', async (t) => {
  let putCount = 0;
  const checkin = createCheckin({
    getConfig: () => ({ username: '', password: '' }),
    coursesFactory: () => ({ fetch: async (url, init = {}) => { if ((init.method || '') === 'PUT') putCount += 1; return ok({}); } }),
  });
  await assert.rejects(
    () => checkin.start(),
    (e) => e.code === 'no_credentials' && e.status === 400
  );
  assert.equal(checkin.getState().phase, 'idle');
  assert.equal(putCount, 0);
});

test('运行中重复启动被拒绝', async (t) => {
  const { checkin } = fixture(t, (courses, url) => ok({ rollcalls: [] }));
  await checkin.start();
  await assert.rejects(() => checkin.start(), (e) => e.code === 'already_running' && e.status === 409);
  checkin.stop();
});
