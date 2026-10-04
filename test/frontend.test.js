import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

// 多页面架构：每个用例指定页面 HTML 与其脚本（shared.js + 页面脚本拼接），
// 在隔离 DOM 中运行真实前端源码，以模拟请求失败与乱序返回。
function page({ html = 'index.html', scripts = ['shared.js', 'app.js'], handler, extras = {} }) {
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag; this.children = []; this.dataset = {}; this.value = ''; this.disabled = false;
      this._text = ''; this.className = ''; this.handlers = {}; this.scrollHeight = 0; this.clientHeight = 0;
      this.classList = { add: c => this.classes().add(c), remove: c => this.classes().delete(c), toggle: (c, value) => value ? this.classes().add(c) : this.classes().delete(c) };
    }
    classes() { return this._classes ??= new Set(); }
    set textContent(value) { this._text = value; this.children = []; }
    get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
    appendChild(child) { child.parent = this; this.children.push(child); if (this.tagName === 'select' && this.children.length === 1) this.value = child.value; return child; }
    append(...children) { children.forEach(c => this.appendChild(c)); }
    prepend(child) { child.parent = this; this.children.unshift(child); }
    replaceChildren(...children) { this.children = []; this.value = ''; this.append(...children); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); }
    querySelector(selector) {
      if (selector === 'b') return this.label ??= new Element('b');
      return this.children.find(c => c.className.split(' ').includes(selector.slice(1))) ?? null;
    }
    addEventListener(type, fn) { this.handlers[type] = fn; }
    setAttribute(name, value) { this[name] = value; }
  }
  const nodes = new Map();
  const htmlText = fs.readFileSync(new URL(`../public/${html}`, import.meta.url), 'utf8');
  // HTML 标记了 disabled 的元素在假 DOM 里也以 disabled 起始，
  // 否则"标记了 disabled 却没有启用逻辑"的 bug 会漏出测试网（签到按钮就栽过）
  for (const match of htmlText.matchAll(/<([\w-]+)[^>]*\bid="([^"]+)"/g)) {
    const node = new Element(match[1]);
    if (/\bdisabled\b/.test(match[0])) node.disabled = true;
    nodes.set(match[2], node);
  }
  const radio = new Element('input'); radio.value = 'monitor';
  const state = { phase: 'idle', course: null, session: null, stats: { fragments: 0, alerts: 0 }, config: { enableDingtalk: false, keywords: ['签到'] } };
  const context = vm.createContext({
    document: { getElementById: id => nodes.get(id), createElement: tag => new Element(tag), createTextNode: text => { const e = new Element(); e.textContent = text; return e; }, querySelector: () => radio, querySelectorAll: () => [radio] },
    // /api/state 与 /api/settings 用固定快照，其余走 handler；
    // handler 返回 httpStatus ≥ 400 时模拟 HTTP 层失败（业务层 ok:false 不受影响）
    fetch: async (url, opts) => {
      const body = url === '/api/state' ? state : url === '/api/settings' && !(opts && opts.method) ? { keywords: '签到', keywordCooldownSeconds: 120 } : handler(url, opts);
      const status = body?.httpStatus || 200;
      return { ok: status < 400, status, json: async () => body };
    },
    EventSource: class {}, setTimeout: () => 0, console,
    URLSearchParams, // 页面代码拼接下载链接等查询串时会用到
    location: { href: 'http://localhost/' },
    ...extras,
  });
  const source = scripts
    .map(name => fs.readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8'))
    .join('\n;\n');
  vm.runInContext(source, context);
  return { nodes, run: code => vm.runInContext(code, context) };
}

// ---------- 直播台（index.html + shared.js + app.js） ----------

test('直播台：加载课程后自动加载第一门课的场次', async () => {
  const p = page({ handler: url => url === '/api/courses' ? { courses: [{ id: '1', title: '课程' }] } : { sessions: [{ subId: '2', title: '第一课' }] } });
  await p.run('loadCourses()');
  assert.equal(p.nodes.get('session-select').value, '2');
  assert.equal(p.nodes.get('session-select').disabled, false);
});

test('直播台：切换课程后，旧请求不会覆盖新场次', async () => {
  let resolveOld;
  const old = new Promise(resolve => { resolveOld = resolve; });
  const p = page({ handler: url => url.includes('/old/') ? old : { sessions: [{ subId: 'new-session', title: '新场次' }] } });
  p.run('courses = [{id: "old"}, {id: "new"}]; $("course-select").value = "old"');
  const first = p.run('loadSessions()');
  p.run('$("course-select").value = "new"');
  await p.run('loadSessions()');
  resolveOld({ sessions: [{ subId: 'old-session' }] });
  await first;
  assert.equal(p.nodes.get('session-select').value, 'new-session');
});

test('直播台：空课程列表不发起无效的场次请求', async () => {
  let sessionCalls = 0;
  const p = page({ handler: url => {
    if (url === '/api/courses') return { courses: [] };
    sessionCalls++;
    return { sessions: [] };
  } });
  await p.run('loadCourses()');
  assert.equal(sessionCalls, 0);
  assert.equal(p.nodes.get('course-select').disabled, true);
});

test('直播台：告警可按文本与未送达筛选', async () => {
  const p = page({ handler: () => ({}) });
  p.run(`rebuildAlerts([
    { at: 1, hits: ['签到'], sentence: '请大家签到', sent: true },
    { at: 2, hits: ['点名'], sentence: '开始点名了', sent: false, reason: 'timeout' },
  ])`);
  const rows = () => p.nodes.get('alerts-body').children.length;
  assert.equal(rows(), 2);
  p.run('$("alert-search").value = "点名"');
  p.run('$("alert-search").handlers.input()');
  assert.equal(rows(), 1);
  assert.ok(p.nodes.get('alerts-body').textContent.includes('开始点名了'));
  p.run('$("alert-search").value = ""');
  p.run('$("alert-search").handlers.input()');
  p.run('$("btn-alert-fail").handlers.click()');
  assert.equal(rows(), 1, '仅看未送达只保留推送失败的一条');
  assert.equal(p.nodes.get('alert-filter-count').textContent, '1 / 2 条');
});

test('直播台：命中关键词筛选芯片可过滤并可取消', () => {
  const p = page({ handler: () => ({}) });
  p.run(`rebuildAlerts([
    { at: 1, hits: ['签到'], sentence: '请大家签到', sent: true },
    { at: 2, hits: ['点名'], sentence: '开始点名了', sent: true },
  ])`);
  const chip = p.nodes.get('alert-hit-chips').children.find(c => c.textContent === '签到');
  chip.handlers.click();
  const rows = () => p.nodes.get('alerts-body').children.length;
  assert.equal(rows(), 1);
  chip.handlers.click();
  assert.equal(rows(), 2);
});

test('直播台：运行中显示已运行时长与监听通道', () => {
  const p = page({ handler: () => ({}) });
  p.run(`applyState({ phase: 'running', startedAt: ${Date.now() - 65000}, course: { title: '课程' }, session: { title: '第一课' }, stats: { fragments: 0, alerts: 0 }, config: { enableDingtalk: false, keywords: ['签到'] }, listenerKind: 'ws', degraded: false })`);
  assert.ok(p.nodes.get('task-meta').textContent.includes('已运行 1 分'));
  assert.ok(p.nodes.get('task-meta').textContent.includes('WebSocket 直连'));
});

// ---------- 连通性徽标跨页面恢复（shared.js + 各页） ----------

test('徽标：状态快照恢复服务端已验证的连通状态', () => {
  const p = page({ handler: () => ({}) });
  const now = Date.now();
  p.run(`applyStateToChecks({ config: { enableDingtalk: true }, verified: { zhiyun: { at: ${now}, detail: '7 门课' }, ding: { at: ${now}, detail: '测试消息已发送' } } })`);
  assert.equal(p.nodes.get('chip-zhiyun').dataset.state, 'ok');
  assert.equal(p.nodes.get('chip-ding').dataset.state, 'ok');
  // 钉钉已关闭：显示"未启用"而不是"已连通"；智云仍恢复已连通
  p.run(`setCheck('zhiyun', 'idle'); setCheck('ding', 'idle'); applyStateToChecks({ config: { enableDingtalk: false }, verified: { zhiyun: { at: ${now} }, ding: { at: ${now} } } })`);
  assert.equal(p.nodes.get('chip-zhiyun').dataset.state, 'ok');
  assert.equal(p.nodes.get('chip-ding').dataset.state, 'disabled');
});

test('徽标：服务端无验证记录时不改变本地状态', () => {
  const p = page({ handler: () => ({}) });
  p.run(`setCheck('zhiyun', 'fail', '密码错误'); applyStateToChecks({ config: {}, verified: {} })`);
  assert.equal(p.nodes.get('chip-zhiyun').dataset.state, 'fail');
});

test('签到页：hello 快照恢复徽标与连接点', () => {
  const p = page({ html: 'checkin.html', scripts: ['shared.js', 'checkin.js'], handler: () => ({}) });
  p.run(`handleEvent({ type: 'hello', payload: { state: { config: { enableDingtalk: true }, verified: { zhiyun: { at: ${Date.now()}, detail: '7 门课' } } }, checkin: null } })`);
  assert.equal(p.nodes.get('chip-zhiyun').dataset.state, 'ok');
  p.run('setConnection(true)');
  assert.equal(p.nodes.get('connection-status').textContent, '已连接');
});

test('课件页：hello 快照恢复徽标与连接点', () => {
  const p = page({ html: 'deck.html', scripts: ['shared.js', 'deck.js'], handler: () => ({}) });
  p.run(`handleEvent({ type: 'hello', payload: { state: { config: { enableDingtalk: true }, verified: { ding: { at: ${Date.now()}, detail: '测试消息已发送' } } } } })`);
  assert.equal(p.nodes.get('chip-ding').dataset.state, 'ok');
  p.run('setConnection(true)');
  assert.equal(p.nodes.get('connection-status').textContent, '已连接');
});

// ---------- 自动签到（checkin.html + shared.js + checkin.js） ----------

const runningCheckin = {
  phase: 'running', startedAt: 1, stoppedAt: null, stopReason: null, lastError: null,
  stats: { seen: 1, answered: 2, failed: 0, active: 1 }, idleStopMs: 900000,
  results: [{ rollcallId: 9, at: 1000, kind: 'number', courseTitle: '课程', title: '点名', outcome: 'success', detail: '口令 1337' }],
};

test('签到：点击开启后按钮与状态行翻转，结果表渲染', async () => {
  const p = page({ html: 'checkin.html', scripts: ['shared.js', 'checkin.js'], handler: url => url === '/api/checkin/start' ? { state: runningCheckin } : {} });
  await p.run('toggleCheckin()');
  const btn = p.nodes.get('btn-checkin');
  assert.equal(btn.textContent, '■ 停止签到');
  assert.ok(btn.classes().has('on'));
  const status = p.nodes.get('checkin-status').textContent;
  assert.ok(status.includes('轮询中'));
  assert.ok(status.includes('已签到 2'));
  assert.ok(status.includes('15 分钟后自动停止'));
  const table = p.nodes.get('checkin-results');
  assert.equal(table.children.length, 1);
  assert.ok(table.textContent.includes('课程'));
  assert.ok(table.textContent.includes('已签到 · 口令 1337'));
});

test('签到：运行中再次点击发送停止请求', async () => {
  let request = '';
  const p = page({ html: 'checkin.html', scripts: ['shared.js', 'checkin.js'], handler: (url, opts) => {
    request = `${opts?.method || 'GET'} ${url}`;
    return { state: { ...runningCheckin, phase: 'stopped', stopReason: 'manual', startedAt: null, stoppedAt: 2, results: [] } };
  } });
  p.run(`applyCheckinState(${JSON.stringify(runningCheckin)})`);
  await p.run('toggleCheckin()');
  assert.equal(request, 'POST /api/checkin/stop');
  assert.equal(p.nodes.get('btn-checkin').textContent, '▷ 开启签到');
  assert.ok(p.nodes.get('checkin-status').textContent.includes('手动停止'));
});

test('签到：终态 toast 不因重复快照而重复弹出', async () => {
  const p = page({ html: 'checkin.html', scripts: ['shared.js', 'checkin.js'], handler: () => ({}) });
  p.run(`applyCheckinState(${JSON.stringify(runningCheckin)})`);
  p.run(`applyCheckinState(${JSON.stringify(runningCheckin)})`);
  assert.equal(p.nodes.get('toasts').children.length, 0, '首次快照与重复快照不弹 toast');
  const retry = { ...runningCheckin, results: [{ ...runningCheckin.results[0], at: 2000 }] };
  p.run(`applyCheckinState(${JSON.stringify(retry)})`);
  const toasts = p.nodes.get('toasts').children;
  assert.equal(toasts.length, 1);
  assert.ok(toasts[0].textContent.includes('已自动签到：课程'));
});

test('签到：接口报错时弹出错误 toast', async () => {
  const p = page({ html: 'checkin.html', scripts: ['shared.js', 'checkin.js'], handler: url => url === '/api/checkin/start' ? { httpStatus: 400, error: { message: '签到模式已在运行' } } : {} });
  p.run('$("btn-checkin").disabled = false');
  await p.run('$("btn-checkin").handlers.click()');
  const toasts = p.nodes.get('toasts').children;
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].className, 'toast err');
  assert.ok(toasts[0].textContent.includes('签到模式已在运行'));
});

test('签到：页面加载后按钮即可点击，不应停留在初始 disabled', () => {
  const p = page({ html: 'checkin.html', scripts: ['shared.js', 'checkin.js'], handler: () => ({}) });
  assert.equal(p.nodes.get('btn-checkin').disabled, false, '签到按钮加载后必须可点击');
});

test('签到：统计卡片展示已签到/失败/待应答/运行时长', () => {
  const p = page({ html: 'checkin.html', scripts: ['shared.js', 'checkin.js'], handler: () => ({}) });
  p.run(`applyCheckinState({ ...${JSON.stringify(runningCheckin)}, startedAt: ${Date.now() - 65000} })`);
  assert.equal(p.nodes.get('checkin-mini-stats').classes().has('hidden'), false);
  assert.equal(p.nodes.get('stat-answered').textContent, '2');
  assert.equal(p.nodes.get('stat-failed').textContent, '0');
  assert.equal(p.nodes.get('stat-active').textContent, '1');
  assert.ok(p.nodes.get('stat-runtime').textContent.includes('1 分'));
});

test('签到：只看失败筛选记录表', () => {
  const p = page({ html: 'checkin.html', scripts: ['shared.js', 'checkin.js'], handler: () => ({}) });
  const state = { ...runningCheckin, results: [
    { rollcallId: 1, at: 1, kind: 'radar', courseTitle: 'A课', outcome: 'success', detail: '' },
    { rollcallId: 2, at: 2, kind: 'number', courseTitle: 'B课', outcome: 'failed', detail: '未找到口令' },
  ] };
  p.run(`applyCheckinState(${JSON.stringify(state)})`);
  const rows = () => p.nodes.get('checkin-results').children.length;
  assert.equal(rows(), 2);
  p.run('$("btn-checkin-fail").handlers.click()');
  assert.equal(rows(), 1);
  assert.ok(p.nodes.get('checkin-results').textContent.includes('B课'));
  p.run('$("btn-checkin-fail").handlers.click()');
  assert.equal(rows(), 2);
});

// ---------- 课件库（deck.html + shared.js + deck.js） ----------

test('课件库：加载课程与场次后解锁下载按钮', async () => {
  const p = page({ html: 'deck.html', scripts: ['shared.js', 'deck.js'], handler: url => url === '/api/courses' ? { courses: [{ id: '1', title: '课程' }] } : { sessions: [{ subId: '2', title: '第一课' }] } });
  await p.run('loadCourses()');
  assert.equal(p.nodes.get('session-select').value, '2');
  assert.equal(p.nodes.get('btn-deck').disabled, false);
});

test('课件库：未选场次时下载直接提示', async () => {
  const p = page({ html: 'deck.html', scripts: ['shared.js', 'deck.js'], handler: () => ({}) });
  await assert.rejects(p.run('downloadDeck()'), /请先选择课程和场次/);
});

test('课件库：记住上次选择的课程与场次，并显示场次信息', async () => {
  const backing = new Map();
  const ls = { getItem: k => (backing.has(k) ? backing.get(k) : null), setItem: (k, v) => backing.set(k, String(v)), removeItem: k => backing.delete(k) };
  ls.setItem('deck.lastChoice', JSON.stringify({ courseId: '1', subId: '2' }));
  const p = page({
    html: 'deck.html', scripts: ['shared.js', 'deck.js'], extras: { localStorage: ls },
    handler: url => url === '/api/courses' ? { courses: [{ id: '1', title: '课程' }, { id: '9', title: '别的课' }] } : { sessions: [{ subId: '2', title: '第一课', startLabel: '09-01 10:00', statusText: '已结束' }, { subId: '3', title: '第二课' }] },
  });
  await p.run('loadCourses()');
  assert.equal(p.nodes.get('course-select').value, '1');
  assert.equal(p.nodes.get('session-select').value, '2');
  assert.equal(p.nodes.get('session-info').classes().has('hidden'), false);
  assert.ok(p.nodes.get('session-info').textContent.includes('已结束'));
});

test('课件库：导出后进入历史，可再次导出', async () => {
  const backing = new Map();
  const ls = { getItem: k => (backing.has(k) ? backing.get(k) : null), setItem: (k, v) => backing.set(k, String(v)), removeItem: k => backing.delete(k) };
  let requested = '';
  const p = page({
    html: 'deck.html', scripts: ['shared.js', 'deck.js'], extras: { localStorage: ls },
    handler: url => { requested = url; return { httpStatus: 500, error: { message: '测试环境无法生成' } }; },
  });
  p.run(`rememberExport({ at: 1700000000000, file: '课程A - 第一课.pptx', kb: 123, courseId: '1', subId: '2', courseTitle: '课程A', sessionTitle: '第一课' })`);
  const items = p.nodes.get('deck-history').children;
  assert.equal(items.length, 1);
  assert.ok(items[0].textContent.includes('课程A - 第一课.pptx'));
  // 再次导出直接携带历史条目的参数，不依赖当前下拉选择
  await items[0].children.find(c => c.tagName === 'button').handlers.click();
  assert.ok(requested.startsWith('/api/deck?courseId=1&subId=2&courseTitle='), `实际请求：${requested}`);
  assert.equal(p.nodes.get('deck-error').classes().has('hidden'), false, '失败原因应显示在页面上');
});

// ---------- 设置（settings.html + shared.js + settings.js） ----------

test('设置：登录接口返回 ok=false 时正确显示失败', async () => {
  const p = page({ html: 'settings.html', scripts: ['shared.js', 'settings.js'], handler: url => url === '/api/login-test' ? { ok: false, error: '密码错误' } : {} });
  await p.run('saveZhiyunAndTest($("btn-save-test-zhiyun"))');
  assert.equal(p.nodes.get('chip-zhiyun').dataset.state, 'fail');
  assert.equal(p.nodes.get('zhiyun-status').textContent, '密码错误');
});

test('设置：关键词保存后刷新预览', async () => {
  const p = page({ html: 'settings.html', scripts: ['shared.js', 'settings.js'], handler: (url, opts) => url === '/api/settings' && opts?.method === 'PUT' ? { settings: { keywords: '签到,点名' } } : {} });
  p.run('$("kw-input").value = "签到,点名"; $("kw-cooldown").value = "60"');
  await p.run('applyKeywords()');
  const preview = p.nodes.get('keyword-preview').children.map(c => c.textContent);
  assert.deepEqual(preview, ['签到', '点名']);
});

test('设置：点击词条移除关键词，等待「应用」保存', () => {
  const p = page({ html: 'settings.html', scripts: ['shared.js', 'settings.js'], handler: () => ({}) });
  p.run(`savedKeywords = ['签到', '点名']; renderKeywordPreview()`);
  const chips = () => p.nodes.get('keyword-preview').children;
  assert.equal(chips().length, 2);
  chips().find(c => c.textContent === '签到').handlers.click();
  assert.equal(chips().length, 1, '移除后预览只剩一个词条');
  assert.equal(p.nodes.get('kw-input').value, '点名', '待保存内容进入输入框，等用户点应用');
});

test('设置：密码与密钥支持显隐切换', () => {
  const p = page({ html: 'settings.html', scripts: ['shared.js', 'settings.js'], handler: () => ({}) });
  p.run('$("set-password").type = "password"; $("set-ding-secret").type = "password"');
  p.run('$("btn-toggle-password").handlers.click()');
  assert.equal(p.nodes.get('set-password').type, 'text');
  assert.equal(p.nodes.get('btn-toggle-password').textContent, '隐藏');
  p.run('$("btn-toggle-password").handlers.click()');
  assert.equal(p.nodes.get('set-password').type, 'password');
  p.run('$("btn-toggle-secret").handlers.click()');
  assert.equal(p.nodes.get('set-ding-secret').type, 'text');
});

test('设置：配置进度清单反映三项连通状态', async () => {
  const p = page({ html: 'settings.html', scripts: ['shared.js', 'settings.js'], handler: url => url === '/api/login-test' ? { ok: true, courseCount: 7, elapsedMs: 800 } : {} });
  const steps = () => p.nodes.get('setup-steps').children.map(c => c.textContent);
  await p.run('saveZhiyunAndTest($("btn-save-test-zhiyun"))');
  assert.ok(steps()[0].includes('① 智云登录'));
  assert.ok(p.nodes.get('setup-steps').children[0].className.includes('done'), '智云测试成功后第一步点亮');
});
