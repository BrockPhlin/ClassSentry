import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

// 在隔离 DOM 中运行实际前端脚本，以模拟请求失败与乱序返回。
function page(handler) {
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
  for (const match of fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').matchAll(/<([\w-]+)[^>]*\bid="([^"]+)"/g)) nodes.set(match[2], new Element(match[1]));
  const radio = new Element('input'); radio.value = 'monitor';
  const state = { phase: 'idle', course: null, session: null, stats: { fragments: 0, alerts: 0 }, config: { enableDingtalk: false, keywords: ['签到'] } };
  const context = vm.createContext({
    document: { getElementById: id => nodes.get(id), createElement: tag => new Element(tag), createTextNode: text => { const e = new Element(); e.textContent = text; return e; }, querySelector: () => radio, querySelectorAll: () => [radio] },
    fetch: async (url, opts) => ({ ok: true, json: async () => url === '/api/state' ? state : url === '/api/settings' && !opts.method ? { keywords: '签到', keywordCooldownSeconds: 120 } : handler(url, opts) }),
    EventSource: class {}, setTimeout: () => 0, console,
  });
  vm.runInContext(fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  return { nodes, run: code => vm.runInContext(code, context) };
}

test('加载课程后自动加载第一门课的场次', async () => {
  const p = page(url => url === '/api/courses' ? { courses: [{ id: '1', title: '课程' }] } : { sessions: [{ subId: '2', title: '第一课' }] });
  await p.run('loadCourses()');
  assert.equal(p.nodes.get('session-select').value, '2');
  assert.equal(p.nodes.get('session-select').disabled, false);
});

test('登录接口返回 ok=false 时正确显示失败', async () => {
  const p = page(url => url === '/api/login-test' ? { ok: false, error: '密码错误' } : {});
  await p.run('saveZhiyunAndTest($("btn-save-test-zhiyun"))');
  assert.equal(p.nodes.get('chip-zhiyun').dataset.state, 'fail');
  assert.equal(p.nodes.get('zhiyun-status').textContent, '密码错误');
});

test('切换课程后，旧请求不会覆盖新场次', async () => {
  let resolveOld;
  const old = new Promise(resolve => { resolveOld = resolve; });
  const p = page(url => url.includes('/old/') ? old : { sessions: [{ subId: 'new-session', title: '新场次' }] });
  p.run('courses = [{id: "old"}, {id: "new"}]; $("course-select").value = "old"');
  const first = p.run('loadSessions()');
  p.run('$("course-select").value = "new"');
  await p.run('loadSessions()');
  resolveOld({ sessions: [{ subId: 'old-session' }] });
  await first;
  assert.equal(p.nodes.get('session-select').value, 'new-session');
});


test('空课程列表不发起无效的场次请求', async () => {
  let sessionCalls = 0;
  const p = page(url => {
    if (url === '/api/courses') return { courses: [] };
    sessionCalls++;
    return { sessions: [] };
  });
  await p.run('loadCourses()');
  assert.equal(sessionCalls, 0);
  assert.equal(p.nodes.get('course-select').disabled, true);
});
