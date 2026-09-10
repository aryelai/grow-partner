const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequestId, getDecision } = require("../miniprogram/utils/subscription");

function createSettingsData() {
  return {
    family: {
      childName: "测试孩子",
      childNickname: "",
      className: "一班",
      educationStage: "junior_high",
      grade: "1",
      childBirthday: "2013-01-01",
      inviteCode: "ABCDEF",
      currentSemester: "2026秋",
    },
    settings: {
      aiProvider: "deepseek",
      aiBaseUrl: "",
      aiModel: "",
      reminderDefaultAdvance: [1440],
      reminderTargets: ["father"],
      allowMemberEditSettings: false,
    },
    currentRole: "member",
  };
}

function createReminderStatus() {
  return {
    enabled: true,
    templateId: "template-id",
    estimatedAvailableCount: 2,
    pendingCount: 1,
    blockedReason: "",
  };
}

function loadSettingsPage(overrides = {}) {
  const sourcePath = path.join(__dirname, "../miniprogram/pages/settings/settings.js");
  const source = fs.readFileSync(sourcePath, "utf8");
  let pageConfig;
  const wx = overrides.wx || { showToast() {}, navigateTo() {}, setClipboardData() {} };
  const api = overrides.api || { callFunction: async () => createSettingsData(), showError() {} };
  const subscription = overrides.subscription || { requestReminderSubscription: async () => ({ templateId: "template-id", decision: "accept", requestId: "subscription_request" }) };
  const testConsole = overrides.console || { error() {} };
  const moduleValue = { exports: {} };
  const context = vm.createContext({
    console: testConsole,
    Page(config) { pageConfig = config; },
    wx,
    module: moduleValue,
    exports: moduleValue.exports,
    require(request) {
      if (request === "../../utils/api") return api;
      if (request === "../../utils/session") return { requireFamily: async () => ({}) };
      if (request === "../../utils/constants") return { EDUCATION_STAGES: [{ value: "junior_high", label: "初中" }] };
      if (request === "../../utils/date") return { getAdjacentSemester: () => "2026秋", formatDate: (value) => value };
      if (request === "../../utils/invite-code") return { formatInviteCode: (value) => value };
      if (request === "../../utils/subscription") return subscription;
      throw new Error(`测试未实现依赖：${request}`);
    },
  });
  vm.runInContext(source, context, { filename: sourcePath });
  const page = {
    data: JSON.parse(JSON.stringify(pageConfig.data)),
    setData(changes) {
      Object.entries(changes).forEach(([key, value]) => {
        const keys = key.split(".");
        let target = this.data;
        while (keys.length > 1) {
          const currentKey = keys.shift();
          target[currentKey] = target[currentKey] || {};
          target = target[currentKey];
        }
        target[keys[0]] = value;
      });
    },
  };
  Object.entries(pageConfig).forEach(([key, value]) => {
    if (typeof value === "function") page[key] = value;
  });

  return { pageConfig, page };
}

test("订阅结果只读取目标模板", () => {
  const templateId = "template-id";

  assert.equal(getDecision({ [templateId]: "accept", errMsg: "ok" }, templateId), "accept");
  assert.throws(() => getDecision({ [templateId]: "unexpected" }, templateId), /Invalid subscription decision/);
});

test("订阅请求编号满足服务端格式", () => {
  const requestId = createRequestId(1788796800000, 0.123456789);

  assert.match(requestId, /^[A-Za-z0-9_-]{16,64}$/);
});

test("设置页并行读取设置和提醒状态", async () => {
  const calls = [];
  const fixture = loadSettingsPage({
    api: {
      callFunction(name, action) {
        calls.push(`${name}.${action}`);
        return Promise.resolve(name === "settings" ? createSettingsData() : createReminderStatus());
      },
      showError() {},
    },
  });

  const loading = fixture.pageConfig.load.call(fixture.page);

  assert.deepEqual(calls, ["settings.get", "reminder.getStatus"]);
  await loading;
  assert.deepEqual(fixture.page.data.reminderStatus, createReminderStatus());
});

test("设置页默认提前量只保留单个选项", () => {
  const fixture = loadSettingsPage();

  fixture.pageConfig.onAdvanceChange.call(fixture.page, { detail: { value: "120" } });

  assert.deepEqual(JSON.parse(JSON.stringify(fixture.page.data.settings.reminderDefaultAdvance)), [120]);
  assert.equal(fixture.page.data.advanceDay, false);
  assert.equal(fixture.page.data.advanceHours, true);
});

test("接受订阅后才登记并刷新提醒状态", async () => {
  const events = [];
  let resolveSubscription;
  const fixture = loadSettingsPage({
    api: {
      callFunction(name, action, data) {
        events.push(`${name}.${action}`);
        if (name === "reminder" && action === "recordSubscription") {
          assert.deepEqual(data, { templateId: "template-id", decision: "accept", requestId: "subscription_request" });
          return Promise.resolve(createReminderStatus());
        }
        return Promise.resolve(name === "settings" ? createSettingsData() : createReminderStatus());
      },
      showError() {},
    },
    subscription: {
      requestReminderSubscription(templateId) {
        events.push(`subscription.${templateId}`);
        return new Promise((resolve) => { resolveSubscription = resolve; });
      },
    },
  });
  fixture.page.data.reminderStatus = createReminderStatus();

  const requesting = fixture.pageConfig.addReminderSubscription.call(fixture.page);

  assert.deepEqual(events, ["subscription.template-id"]);
  resolveSubscription({ templateId: "template-id", decision: "accept", requestId: "subscription_request" });
  await requesting;
  assert.deepEqual(events, ["subscription.template-id", "reminder.recordSubscription", "settings.get", "reminder.getStatus"]);
});

test("未接受订阅不登记可用次数", async () => {
  const events = [];
  const toasts = [];
  const fixture = loadSettingsPage({
    api: {
      callFunction(name, action) {
        events.push(`${name}.${action}`);
        return Promise.resolve(createReminderStatus());
      },
      showError() {},
    },
    subscription: { requestReminderSubscription: async () => ({ templateId: "template-id", decision: "reject", requestId: "subscription_request" }) },
    wx: { showToast(options) { toasts.push(options); }, navigateTo() {}, setClipboardData() {} },
  });
  fixture.page.data.reminderStatus = createReminderStatus();

  await fixture.pageConfig.addReminderSubscription.call(fixture.page);

  assert.deepEqual(events, []);
  assert.deepEqual(JSON.parse(JSON.stringify(toasts)), [{ title: "你已拒绝本次提醒授权，可在需要时再次开启", icon: "none" }]);
});

test("提醒状态查询失败时仍加载设置并标记为不可用", async () => {
  const errors = [];
  const fixture = loadSettingsPage({
    api: {
      callFunction(name) {
        if (name === "settings") return Promise.resolve(createSettingsData());
        return Promise.reject(new Error("提醒状态请求失败"));
      },
      showError(error) { errors.push(error); },
    },
  });

  await fixture.pageConfig.load.call(fixture.page);

  assert.equal(fixture.page.data.family.childName, "测试孩子");
  assert.equal(fixture.page.data.reminderStatus.enabled, false);
  assert.equal(fixture.page.data.reminderStatus.blockedReason, "STATUS_UNAVAILABLE");
  assert.equal(fixture.page.data.reminderStatusText, "提醒状态暂不可用");
  assert.equal(fixture.page.data.reminderStatusDetail, "暂时无法读取提醒状态，请重新查询后再授权");
  assert.deepEqual(errors, []);
});

test("提醒功能未启用时不发起微信授权或订阅登记", async () => {
  const events = [];
  const toasts = [];
  const fixture = loadSettingsPage({
    api: {
      callFunction(name, action) {
        events.push(`${name}.${action}`);
        return Promise.resolve(createReminderStatus());
      },
      showError() {},
    },
    subscription: {
      requestReminderSubscription() {
        events.push("subscription.request");
        return Promise.resolve({ templateId: "template-id", decision: "accept", requestId: "subscription_request" });
      },
    },
    wx: { showToast(options) { toasts.push(options); }, navigateTo() {}, setClipboardData() {} },
  });
  fixture.page.data.reminderStatus = { ...createReminderStatus(), enabled: false, blockedReason: "CONFIGURATION" };
  fixture.page.data.reminderStatusDetail = "提醒服务尚未配置，暂不能增加提醒次数";

  await fixture.pageConfig.addReminderSubscription.call(fixture.page);

  assert.deepEqual(events, []);
  assert.deepEqual(JSON.parse(JSON.stringify(toasts)), [{ title: "提醒服务尚未配置，暂不能增加提醒次数", icon: "none" }]);
});

test("配置未启用时显示可理解的提醒功能状态", async () => {
  const fixture = loadSettingsPage({
    api: {
      callFunction(name) {
        return Promise.resolve(name === "settings" ? createSettingsData() : { ...createReminderStatus(), enabled: false, blockedReason: "CONFIGURATION" });
      },
      showError() {},
    },
  });

  await fixture.pageConfig.load.call(fixture.page);

  assert.equal(fixture.page.data.reminderStatusText, "提醒功能未启用");
  assert.equal(fixture.page.data.reminderStatusDetail, "提醒服务尚未配置，暂不能增加提醒次数");
});

test("微信授权失败时保留原生错误上下文并显示错误信息", async () => {
  const reportedErrors = [];
  const logs = [];
  const fixture = loadSettingsPage({
    api: {
      callFunction() { throw new Error("不应登记订阅"); },
      showError(error) { reportedErrors.push(error); },
    },
    subscription: { requestReminderSubscription: async () => Promise.reject({ errMsg: "requestSubscribeMessage:fail", errCode: 20004 }) },
    console: { error(...args) { logs.push(args); } },
  });
  fixture.page.data.reminderStatus = createReminderStatus();

  await fixture.pageConfig.addReminderSubscription.call(fixture.page);

  assert.equal(reportedErrors[0].message, "requestSubscribeMessage:fail");
  assert.equal(reportedErrors[0].errMsg, "requestSubscribeMessage:fail");
  assert.equal(reportedErrors[0].errCode, 20004);
  assert.deepEqual(JSON.parse(JSON.stringify(logs[0][1])), { message: "", errMsg: "requestSubscribeMessage:fail", code: "", errCode: 20004 });
});

test("订阅登记失败时保留云函数错误码上下文", async () => {
  const reportedErrors = [];
  const logs = [];
  const fixture = loadSettingsPage({
    api: {
      callFunction(name, action) {
        if (name === "reminder" && action === "recordSubscription") return Promise.reject({ message: "订阅登记失败", code: "RECORD_FAILED" });
        return Promise.resolve(createSettingsData());
      },
      showError(error) { reportedErrors.push(error); },
    },
    subscription: { requestReminderSubscription: async () => ({ templateId: "template-id", decision: "accept", requestId: "subscription_request" }) },
    console: { error(...args) { logs.push(args); } },
  });
  fixture.page.data.reminderStatus = createReminderStatus();

  await fixture.pageConfig.addReminderSubscription.call(fixture.page);

  assert.equal(reportedErrors[0].message, "订阅登记失败");
  assert.equal(reportedErrors[0].code, "RECORD_FAILED");
  assert.deepEqual(JSON.parse(JSON.stringify(logs[0][1])), { message: "订阅登记失败", errMsg: "", code: "RECORD_FAILED", errCode: "" });
});
