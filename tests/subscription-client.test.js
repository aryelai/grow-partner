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
  const moduleValue = { exports: {} };
  const context = vm.createContext({
    console,
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
