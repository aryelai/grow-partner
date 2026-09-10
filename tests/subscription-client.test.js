const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequestId, getDecision, shouldRequestSubscription } = require("../miniprogram/utils/subscription");

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

function createNoticeSession() {
  return {
    user: { familyId: "family-id", relation: "father", role: "creator" },
    family: { currentSemester: "2026下" },
  };
}

function createNoticePage(sourceName, overrides = {}) {
  const sourcePath = path.join(__dirname, `../miniprogram/pages/${sourceName}/${sourceName}.js`);
  const source = fs.readFileSync(sourcePath, "utf8");
  let pageConfig;
  const wx = overrides.wx || { showToast() {}, showModal() {}, navigateBack() {}, navigateTo() {}, previewImage() {} };
  const api = overrides.api || { callFunction: async () => ({}), showError() {}, uploadFile: async () => "cloud://image" };
  const subscription = {
    requestReminderSubscription: async () => ({ templateId: "template-id", decision: "reject", requestId: "subscription_request" }),
    shouldRequestSubscription,
    ...overrides.subscription,
  };
  const moduleValue = { exports: {} };
  const context = vm.createContext({
    Date,
    Page(config) { pageConfig = config; },
    wx,
    module: moduleValue,
    exports: moduleValue.exports,
    require(request) {
      if (request === "../../utils/api") return api;
      if (request === "../../utils/session") return { requireFamily: overrides.requireFamily || (async () => createNoticeSession()) };
      if (request === "../../utils/constants") return {
        NOTICE_CATEGORIES: [{ value: "other", label: "其他" }],
        RELATIONS: { father: "爸爸", mother: "妈妈", child: "孩子" },
      };
      if (request === "../../utils/date") return { formatDate: () => "2026-09-10", formatDateTime: (value) => `时间：${value}` };
      if (request === "../../utils/permissions") return { canPerform: (role, action) => role !== "child" && action === "manageNotice" };
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

test("当前关系在提醒对象中且没有预计次数时需要订阅", () => {
  assert.equal(shouldRequestSubscription({
    reminderEnabled: true,
    currentRelation: "father",
    remindTargets: ["father", "mother"],
    estimatedAvailableCount: 0,
  }), true);
});

test("其他接收人的提醒不能由创建者代订阅", () => {
  assert.equal(shouldRequestSubscription({
    reminderEnabled: true,
    currentRelation: "father",
    remindTargets: ["mother"],
    estimatedAvailableCount: 0,
  }), false);
});

test("通知编辑页新建时采用家庭首个有效默认提前量和提醒对象", async () => {
  const fixture = createNoticePage("notice-edit", {
    api: {
      callFunction(name, action) {
        if (name === "settings" && action === "get") {
          return Promise.resolve({ settings: { reminderDefaultAdvance: [1440, 120], reminderTargets: ["mother", "father", "mother"] } });
        }
        if (name === "reminder" && action === "getStatus") return Promise.resolve({ enabled: true, templateId: "template-id", estimatedAvailableCount: 0, pendingCount: 0, blockedReason: "" });
        throw new Error(`不应调用：${name}.${action}`);
      },
      showError() {},
      uploadFile: async () => "cloud://image",
    },
  });

  await fixture.pageConfig.onLoad.call(fixture.page, {});

  assert.deepEqual(JSON.parse(JSON.stringify(fixture.page.data.form.remindAdvance)), [1440]);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.page.data.form.remindTargets)), ["mother", "father"]);
  assert.equal(fixture.page.data.needsSubscription, false);
});

test("通知编辑页把单选提前量和提醒对象规范为单值去重数组", () => {
  const fixture = createNoticePage("notice-edit");

  fixture.pageConfig.onAdvanceChange.call(fixture.page, { detail: { value: "120" } });
  fixture.pageConfig.onTargetsChange.call(fixture.page, { detail: { value: ["father", "father", "child"] } });

  assert.deepEqual(JSON.parse(JSON.stringify(fixture.page.data.form.remindAdvance)), [120]);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.page.data.form.remindTargets)), ["father", "child"]);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.page.data.reminderRelations.filter((item) => item.checked).map((item) => item.value))), ["father", "child"]);
});

test("通知保存先发起当前用户的订阅授权，拒绝后仍保存并提示", async () => {
  const events = [];
  const toasts = [];
  const fixture = createNoticePage("notice-edit", {
    api: {
      callFunction(name, action) {
        events.push(`${name}.${action}`);
        if (name === "notice" && action === "create") return Promise.resolve({ id: "notice-id" });
        throw new Error(`不应调用：${name}.${action}`);
      },
      showError(error) { throw error; },
      uploadFile: async () => "cloud://image",
    },
    subscription: {
      requestReminderSubscription(templateId) {
        events.push(`subscription.${templateId}`);
        return Promise.resolve({ templateId, decision: "reject", requestId: "subscription_request" });
      },
    },
    wx: {
      showToast(options) { toasts.push(options); }, showModal() {}, navigateBack() { events.push("navigateBack"); }, navigateTo() {}, previewImage() {},
    },
  });
  fixture.page.currentUser = createNoticeSession().user;
  fixture.page.data.form = { ...fixture.page.data.form, title: "家长会", remindAdvance: [120], remindTargets: ["father"] };
  fixture.page.data.reminderEnabled = true;
  fixture.page.data.reminderStatus = { enabled: true, templateId: "template-id", estimatedAvailableCount: 0, pendingCount: 0, blockedReason: "" };

  const saving = fixture.pageConfig.save.call(fixture.page);

  assert.deepEqual(events, ["subscription.template-id"]);
  await saving;
  assert.equal(events.join(","), "subscription.template-id,notice.create,navigateBack");
  assert.deepEqual(JSON.parse(JSON.stringify(toasts)), [{ title: "通知已保存，微信提醒未授权", icon: "none" }]);
});

test("通知详情拒绝非法标识且不请求云函数", async () => {
  const calls = [];
  const toasts = [];
  const fixture = createNoticePage("notice-detail", {
    api: { callFunction() { calls.push("notice.get"); return Promise.resolve({}); }, showError() {}, uploadFile: async () => "cloud://image" },
    wx: { showToast(options) { toasts.push(options); }, showModal() {}, navigateBack() {}, navigateTo() {}, previewImage() {} },
  });

  await fixture.pageConfig.onLoad.call(fixture.page, { id: "../invalid" });

  assert.deepEqual(calls, []);
  assert.deepEqual(JSON.parse(JSON.stringify(toasts)), [{ title: "通知标识无效", icon: "none" }]);
});

test("通知详情显示公开字段并仅向有权限账号开放编辑", async () => {
  const fixture = createNoticePage("notice-detail", {
    api: {
      callFunction(name, action) {
        assert.equal(`${name}.${action}`, "notice.get");
        return Promise.resolve({ _id: "notice-id", category: "other", remindTime: "2026-09-10T08:00:00.000Z", remindAdvance: [1440], remindTargets: ["father", "unknown"], images: ["cloud://image"] });
      },
      showError() {},
      uploadFile: async () => "cloud://image",
    },
  });

  await fixture.pageConfig.onLoad.call(fixture.page, { id: "notice-id" });

  assert.equal(fixture.page.data.item.categoryName, "其他");
  assert.equal(fixture.page.data.item.advanceText, "提前1天");
  assert.equal(fixture.page.data.item.targetText, "爸爸");
  assert.equal(fixture.page.data.canEdit, true);
});

test("通知列表卡片始终导航至只读详情", () => {
  const fixture = createNoticePage("notice-list", {
    wx: { showToast() {}, showModal() {}, navigateBack() {}, navigateTo(options) { fixture.url = options.url; }, previewImage() {} },
  });

  fixture.pageConfig.view.call(fixture.page, { currentTarget: { dataset: { id: "notice-id" } } });

  assert.equal(fixture.url, "/pages/notice-detail/notice-detail?id=notice-id");
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
