// 设置页面：智云/钉钉连通性、预警关键词、高级选项。共享工具见 shared.js。

let savedKeywords = [];

// ---------- 配置进度清单 ----------

function renderSetupSteps() {
  const box = $("setup-steps");
  if (!box) return;
  const step = (label, done, note) => {
    const node = el("span", `setup-step${done ? " done" : ""}`);
    node.append(el("i", "step-dot"), el("b", null, label), el("small", null, note));
    return node;
  };
  const dingDone = checks.ding === "ok" || checks.ding === "disabled";
  box.replaceChildren(
    step("① 智云登录", checks.zhiyun === "ok", CHECK_LABEL[checks.zhiyun]),
    step("② 钉钉推送", dingDone, CHECK_LABEL[checks.ding]),
    step("③ 预警关键词", savedKeywords.length > 0, savedKeywords.length ? `已设 ${savedKeywords.length} 个` : "未设置"),
  );
}

// ---------- 预警关键词 ----------

// 词条预览：输入框有内容时实时反映输入；为空时展示已保存的关键词
function keywordDraft() {
  const typed = $("kw-input").value.trim();
  return typed ? typed.split(/[,，]/).map((word) => word.trim()).filter(Boolean) : savedKeywords;
}

function renderKeywordPreview() {
  const words = keywordDraft();
  const box = $("keyword-preview");
  box.replaceChildren();
  for (const word of words) {
    const chip = el("span", "kw-chip", word);
    chip.title = "点击移除该关键词（还需点「应用」保存）";
    chip.addEventListener("click", () => removeKeyword(word));
    box.appendChild(chip);
  }
  if (!words.length) box.appendChild(el("span", "kw-empty", "尚未设置关键词"));
  renderSetupSteps();
}

function removeKeyword(word) {
  const words = keywordDraft().filter((w) => w !== word);
  $("kw-input").value = words.join("，"); // 输入框成为唯一事实来源，用户确认后再应用
  renderKeywordPreview();
}

async function applyKeywords() {
  const text = $("kw-input").value.trim();
  const cooldown = Number($("kw-cooldown").value);
  if (!text || !Number.isFinite(cooldown) || cooldown <= 0) throw new Error("请填写关键词，并设置大于 0 的冷却时间");
  const data = await api("/api/settings", {
    method: "PUT",
    body: JSON.stringify({ keywords: text, keywordCooldownSeconds: cooldown }),
  });
  savedKeywords = data.settings.keywords.split(",").filter(Boolean);
  $("kw-input").value = "";
  renderKeywordPreview();
  toast("关键词已保存，对下一次监控任务生效", "ok");
}

// ---------- 表单填充 ----------

function fillSettings(settings) {
  $("set-username").value = settings.zjuUsername || "";
  $("set-password").value = "";
  $("set-password").placeholder = settings.hasPassword ? "已设置，留空保持不变" : "未设置";
  $("set-ding-enabled").checked = settings.dingtalk.enabled;
  $("set-ding-webhook").value = settings.dingtalk.webhook || "";
  $("set-ding-webhook").placeholder = "https://oapi.dingtalk.com/robot/send?access_token=...";
  $("set-ding-secret").value = "";
  $("set-ding-secret").placeholder = settings.dingtalk.hasSecret ? "已设置，留空保持不变" : "SEC 开头的加签密钥（关键词模式留空）";
  $("set-alert-title").value = settings.alertTitle;
  $("set-listen-mode").value = settings.listenMode;
  $("set-poll-interval").value = settings.pollIntervalSeconds;
  $("set-final-only").checked = settings.alertOnFinalOnly;
  $("set-debug-raw").checked = settings.debugRaw;
  savedKeywords = settings.keywords.split(",").filter(Boolean);
  renderKeywordPreview();
}

// ---------- 保存与测试 ----------

async function saveZhiyunAndTest(btn) {
  const body = { zjuUsername: $("set-username").value.trim() };
  const password = $("set-password").value;
  if (password) body.password = password;

  btn.disabled = true;
  setCheck("zhiyun", "testing");
  try {
    await api("/api/settings", { method: "PUT", body: JSON.stringify(body) });
    const r = await api("/api/login-test", { method: "POST" });
    if (!r.ok) throw new Error(r.error || "智云登录失败");
    $("set-password").value = "";
    $("set-password").placeholder = "已设置，留空保持不变";
    setCheck("zhiyun", "ok", `${r.courseCount} 门课 · ${(r.elapsedMs / 1000).toFixed(1)}s`);
    toast("智云登录成功，回直播台选课程启动即可", "ok");
  } catch (e) {
    setCheck("zhiyun", "fail", e.message);
    toast(`智云：${e.message}`, "err");
  } finally {
    btn.disabled = false;
    renderSetupSteps();
  }
}

async function saveDingAndTest(btn) {
  const enabled = $("set-ding-enabled").checked;
  const body = {
    dingtalk: {
      enabled,
      webhook: $("set-ding-webhook").value.trim(),
    },
  };
  const secret = $("set-ding-secret").value.trim();
  if (secret) body.dingtalk.secret = secret;

  btn.disabled = true;
  setCheck("ding", "testing");
  try {
    await api("/api/settings", { method: "PUT", body: JSON.stringify(body) });
    $("set-ding-secret").value = "";
    const latest = await api("/api/state");
    applyConfigToChecks(latest.config);
    if (!enabled) {
      setCheck("ding", "disabled", "推送已关闭");
      toast("钉钉推送已关闭", "ok");
      return;
    }
    const r = await api("/api/settings/test-ding", { method: "POST" });
    if (r.ok) {
      setCheck("ding", "ok", "测试消息已发送");
      toast("钉钉测试消息已发送，请到群里确认", "ok");
    } else {
      setCheck("ding", "fail", r.error);
      toast(`钉钉：${r.error}`, "err");
    }
  } catch (e) {
    setCheck("ding", "fail", e.message);
    toast(`钉钉：${e.message}`, "err");
  } finally {
    btn.disabled = false;
    renderSetupSteps();
  }
}

async function saveAdvanced(btn) {
  btn.disabled = true;
  try {
    await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        alertTitle: $("set-alert-title").value,
        listenMode: $("set-listen-mode").value,
        pollIntervalSeconds: Number($("set-poll-interval").value),
        alertOnFinalOnly: $("set-final-only").checked,
        debugRaw: $("set-debug-raw").checked,
      }),
    });
    toast("高级选项已保存，对下一次监控任务生效", "ok");
  } catch (e) {
    toast(e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

// ---------- 密码显隐 ----------

function bindVisibility(btnId, inputId) {
  $(btnId).addEventListener("click", () => {
    const input = $(inputId);
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    $(btnId).textContent = show ? "隐藏" : "显示";
    $(btnId).setAttribute("aria-pressed", String(show));
  });
}

// ---------- 实时事件（恢复连通性徽标与连接状态点） ----------

function handleEvent(event) {
  if (event.type === "hello") {
    applyStateToChecks(event.payload.state);
    renderSetupSteps();
  }
}

function setConnection(connectedNow) {
  const node = $("connection-status");
  node.textContent = connectedNow ? "已连接" : "重连中…";
  node.dataset.state = connectedNow ? "ok" : "offline";
}

// ---------- 绑定与启动 ----------

$("btn-save-test-zhiyun").addEventListener("click", (e) => saveZhiyunAndTest(e.currentTarget));
$("btn-save-test-ding").addEventListener("click", (e) => saveDingAndTest(e.currentTarget));
$("btn-apply-kw").addEventListener("click", () => withBusy($("btn-apply-kw"), applyKeywords, "保存中…").catch((e) => toast(e.message, "err")));
$("btn-save-advanced").addEventListener("click", (e) => saveAdvanced(e.currentTarget));
$("kw-input").addEventListener("input", renderKeywordPreview);
bindVisibility("btn-toggle-password", "set-password");
bindVisibility("btn-toggle-secret", "set-ding-secret");

renderChecks();
renderSetupSteps();
openEvents(handleEvent, setConnection);
api("/api/settings").then(fillSettings).catch(() => {});
api("/api/state").then((s) => {
  applyStateToChecks(s);
  renderSetupSteps();
}).catch(() => {});
