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
      if (request === "../../utils/share") return require("../miniprogram/utils/share");
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

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
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
    console: overrides.console || { error() {} },
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
      if (request === "../../utils/share") return require("../miniprogram/utils/share");
      if (request === "../../utils/guest-experience") return require("../miniprogram/utils/guest-experience");
      if (request === "../../utils/notice") return require("../miniprogram/utils/notice");
      if (request === "../../utils/list-completion") return require("../miniprogram/utils/list-completion");
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
    templateId: "template-id",
  }), true);
});

test("其他接收人的提醒不能由创建者代订阅", () => {
  assert.equal(shouldRequestSubscription({
    reminderEnabled: true,
    currentRelation: "father",
    remindTargets: ["mother"],
    estimatedAvailableCount: 0,
    templateId: "template-id",
  }), false);
});

test("畸形提醒状态不会触发订阅授权", () => {
  const validInput = {
    reminderEnabled: true,
    currentRelation: "father",
    remindTargets: ["father"],
    estimatedAvailableCount: 0,
    templateId: "template-id",
  };

  for (const changes of [
    { reminderEnabled: "true" },
    { reminderEnabled: 1 },
    { estimatedAvailableCount: "0" },
    { estimatedAvailableCount: "" },
    { estimatedAvailableCount: null },
    { estimatedAvailableCount: -1 },
    { estimatedAvailableCount: 51 },
    { estimatedAvailableCount: Infinity },
    { currentRelation: "unknown" },
    { currentRelation: "father", remindTargets: ["unknown"] },
    { templateId: "" },
    { templateId: " template id " },
  ]) {
    assert.equal(shouldRequestSubscription({ ...validInput, ...changes }), false, JSON.stringify(changes));
  }
});

test("正数预计次数不重复请求订阅", () => {
  assert.equal(shouldRequestSubscription({
    reminderEnabled: true,
    currentRelation: "father",
    remindTargets: ["father"],
    estimatedAvailableCount: 1,
    templateId: "template-id",
  }), false);
});

test("通知编辑页初始化期间拒绝保存和输入", async () => {
  const session = createDeferred();
  const settings = createDeferred();
  const status = createDeferred();
  const events = [];
  const fixture = createNoticePage("notice-edit", {
    requireFamily: () => session.promise,
    api: {
      callFunction(name, action) {
        events.push(`${name}.${action}`);
        if (name === "settings") return settings.promise;
        if (name === "reminder") return status.promise;
        if (name === "notice") return Promise.resolve({ id: "notice-id" });
        throw new Error(`不应调用：${name}.${action}`);
      },
      showError(error) { throw error; },
      uploadFile: async () => "cloud://image",
    },
    subscription: { requestReminderSubscription() { events.push("subscription.request"); return Promise.resolve({ decision: "accept" }); } },
  });
  fixture.page.data.form.title = "初始标题";
  fixture.page.data.form.remindTargets = ["father"];
  fixture.page.data.reminderEnabled = true;
  fixture.page.data.reminderStatus = { enabled: true, templateId: "template-id", estimatedAvailableCount: 0 };

  const loading = fixture.pageConfig.onLoad.call(fixture.page, {});
  fixture.pageConfig.onInput.call(fixture.page, { currentTarget: { dataset: { field: "title" } }, detail: { value: "不应写入" } });
  const saving = fixture.pageConfig.save.call(fixture.page);

  assert.equal(fixture.page.data.initializing, true);
  assert.equal(fixture.page.data.form.title, "初始标题");
  assert.equal(saving, undefined);
  assert.deepEqual(events, []);

  session.resolve(createNoticeSession());
  await Promise.resolve();
  settings.resolve({ settings: { reminderDefaultAdvance: [120], reminderTargets: ["father"] } });
  status.resolve({ enabled: true, templateId: "template-id", estimatedAvailableCount: 0, pendingCount: 0, blockedReason: "" });
  await loading;
  assert.equal(fixture.page.data.initializing, false);
});

test("AI 通知草稿默认不启用提醒且必须显式采用时间建议", () => {
  const fixture = createNoticePage("notice-edit");
  fixture.page.currentUser = { relation: "father", role: "creator" };
  fixture.page.data.reminderStatus = { enabled: true, templateId: "template-id", estimatedAvailableCount: 0 };
  fixture.page.data.form.remindTargets = ["father"];

  fixture.page.applyAiDraft({
    requestId: "01010101010101010101010101010101_0",
    semester: "2026下",
    title: "家长会",
    source: "班主任",
    category: "other",
    content: "请提前到场",
    suggestedRemindTime: "2026-09-21T11:00:00.000Z",
  }, "2026下");

  assert.equal(fixture.page.data.form.title, "家长会");
  assert.equal(fixture.page.data.reminderEnabled, false);
  assert.equal(fixture.page.data.aiSuggestedRemindTime, "2026-09-21T11:00:00.000Z");
  fixture.page.useAiSuggestion();
  assert.equal(fixture.page.data.reminderEnabled, true);
  assert.equal(fixture.page.data.aiSuggestedRemindTime, "");
  assert.match(fixture.page.data.remindDate, /^2026-09-(21|22)$/);
  assert.match(fixture.page.data.remindTime, /^\d{2}:\d{2}$/);
});

test("提醒状态读取失败会记录受控上下文并降级保存", async () => {
  const logs = [];
  const fixture = createNoticePage("notice-edit", {
    api: {
      callFunction(name) {
        if (name === "settings") return Promise.resolve({ settings: {} });
        return Promise.reject({ message: `状态失败\n${"x".repeat(240)}`, code: "STATUS_FAILED" });
      },
      showError() {},
      uploadFile: async () => "cloud://image",
    },
    console: { error(...args) { logs.push(args); } },
  });

  await fixture.pageConfig.onLoad.call(fixture.page, {});

  assert.equal(fixture.page.data.reminderStatus.enabled, false);
  assert.equal(logs[0][0], "Reminder status request failed");
  assert.equal(logs[0][1].message.includes("\n"), false);
  assert.ok(logs[0][1].message.length <= 160);
});

test("畸形提醒状态不会弹授权且仍保存通知", async () => {
  const events = [];
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
    subscription: { requestReminderSubscription() { events.push("subscription.request"); return Promise.resolve({ decision: "accept" }); } },
  });
  fixture.page.currentUser = createNoticeSession().user;
  fixture.page.data.form = { ...fixture.page.data.form, title: "家长会", remindAdvance: [120], remindTargets: ["father"] };
  fixture.page.data.reminderEnabled = true;
  fixture.page.data.reminderStatus = { enabled: "true", templateId: "", estimatedAvailableCount: "0" };

  await fixture.pageConfig.save.call(fixture.page);

  assert.deepEqual(events, ["notice.create"]);
});

test("确认弹窗失败和取消都会释放保存锁", () => {
  const modalCalls = [];
  const fixture = createNoticePage("notice-edit", {
    wx: {
      showToast() {}, showModal(options) { modalCalls.push(options); }, navigateBack() {}, navigateTo() {}, previewImage() {},
    },
  });
  fixture.page.data.id = "notice-id";
  fixture.page.data.form = { ...fixture.page.data.form, title: "家长会", remindTargets: ["father"] };
  fixture.page.originalReminder = { remindTime: "2026-09-10T08:00:00.000Z", remindAdvance: [120], remindTargets: ["father"], reminderState: "materialized" };
  fixture.page.data.reminderEnabled = true;
  fixture.page.data.remindDate = "2026-09-11";
  fixture.page.data.remindTime = "08:00";

  fixture.pageConfig.save.call(fixture.page);
  modalCalls[0].fail(new Error("modal failed"));
  assert.equal(fixture.page.saveInProgress, false);
  assert.equal(fixture.page.data.submitting, false);

  fixture.pageConfig.save.call(fixture.page);
  modalCalls[1].success({ confirm: false });
  assert.equal(fixture.page.saveInProgress, false);
  assert.equal(fixture.page.data.submitting, false);
});

test("非法提醒日期不会写入通知且不会锁死保存", () => {
  const fixture = createNoticePage("notice-edit");
  fixture.page.data.id = "notice-id";
  fixture.page.data.form = { ...fixture.page.data.form, title: "家长会", remindTargets: ["father"] };
  fixture.page.originalReminder = { remindTime: "2026-09-10T08:00:00.000Z", remindAdvance: [120], remindTargets: ["father"], reminderState: "materialized" };
  fixture.page.data.reminderEnabled = true;
  fixture.page.data.remindDate = "invalid-date";

  assert.doesNotThrow(() => fixture.pageConfig.save.call(fixture.page));
  assert.notEqual(fixture.page.saveInProgress, true);
  assert.equal(fixture.page.data.submitting, false);
});

test("编辑数据加载失败后页面保持不可保存", async () => {
  const calls = [];
  const navigations = [];
  const fixture = createNoticePage("notice-edit", {
    api: {
      callFunction(name, action) {
        calls.push(`${name}.${action}`);
        if (name === "settings") return Promise.resolve({ settings: {} });
        if (name === "reminder") return Promise.resolve({ enabled: false, templateId: "", estimatedAvailableCount: 0, pendingCount: 0, blockedReason: "CONFIGURATION" });
        if (name === "notice" && action === "get") return Promise.reject(new Error("通知读取失败"));
        throw new Error(`不应调用：${name}.${action}`);
      },
      showError() {},
      uploadFile: async () => "cloud://image",
    },
    wx: { showToast() {}, showModal() {}, navigateBack() { navigations.push("back"); }, navigateTo() {}, previewImage() {} },
  });
  fixture.page.data.form.title = "家长会";

  await fixture.pageConfig.onLoad.call(fixture.page, { id: "notice-id" });
  fixture.pageConfig.save.call(fixture.page);

  assert.equal(fixture.page.data.initializationFailed, true);
  assert.equal(fixture.page.data.initializing, false);
  assert.deepEqual(navigations, ["back"]);
  assert.deepEqual(calls, ["settings.get", "reminder.getStatus", "notice.get"]);
});

function prepareReminderSave(fixture) {
  fixture.page.currentUser = createNoticeSession().user;
  fixture.page.data.form = { ...fixture.page.data.form, title: "家长会", remindAdvance: [120], remindTargets: ["father"] };
  fixture.page.data.reminderEnabled = true;
  fixture.page.data.reminderStatus = { enabled: true, templateId: "template-id", estimatedAvailableCount: 0, pendingCount: 0, blockedReason: "" };
}

test("保存挂起期间冻结全部交互并提交点击时快照", async () => {
  const permission = createDeferred();
  const record = createDeferred();
  const noticeSave = createDeferred();
  const events = [];
  const interactionPromises = [];
  let noticePayload;
  const fixture = createNoticePage("notice-edit", {
    requireFamily() {
      events.push("permission");
      return permission.promise;
    },
    api: {
      callFunction(name, action, data) {
        events.push(`${name}.${action}`);
        if (name === "reminder" && action === "recordSubscription") return record.promise;
        if (name === "notice" && action === "create") {
          noticePayload = structuredClone(data);
          return noticeSave.promise;
        }
        throw new Error(`不应调用：${name}.${action}`);
      },
      showError(error) { throw error; },
      uploadFile() { events.push("uploadFile"); return Promise.resolve("cloud://changed"); },
    },
    subscription: {
      requestReminderSubscription(templateId) {
        events.push(`subscription.${templateId}`);
        return Promise.resolve({ templateId, decision: "accept", requestId: "subscription_request" });
      },
    },
    wx: {
      showToast() {},
      showModal() { events.push("remove.modal"); },
      navigateBack() { events.push("navigateBack"); },
      navigateTo() {},
      previewImage() {},
      chooseMedia() { events.push("chooseMedia"); return Promise.resolve({ tempFiles: [] }); },
    },
  });
  prepareReminderSave(fixture);
  fixture.page.data.form = {
    ...fixture.page.data.form,
    source: "班主任",
    content: "原始正文",
    images: ["cloud://original"],
  };
  fixture.page.data.remindDate = "2026-09-10";
  fixture.page.data.remindTime = "08:00";
  const clickedForm = structuredClone(fixture.page.data.form);
  const expectedState = () => ({
    form: fixture.page.data.form,
    reminderEnabled: fixture.page.data.reminderEnabled,
    remindDate: fixture.page.data.remindDate,
    remindTime: fixture.page.data.remindTime,
    reminderRelations: fixture.page.data.reminderRelations,
  });
  const initialState = structuredClone(expectedState());
  const exerciseInteractions = (label) => {
    fixture.pageConfig.onInput.call(fixture.page, { currentTarget: { dataset: { field: "title" } }, detail: { value: `篡改-${label}` } });
    fixture.pageConfig.selectCategory.call(fixture.page, { currentTarget: { dataset: { value: "changed" } } });
    fixture.pageConfig.toggleReminder.call(fixture.page, { detail: { value: false } });
    fixture.pageConfig.onRemindDate.call(fixture.page, { detail: { value: "2026-09-12" } });
    fixture.pageConfig.onRemindTime.call(fixture.page, { detail: { value: "09:30" } });
    fixture.pageConfig.onAdvanceChange.call(fixture.page, { detail: { value: "1440" } });
    fixture.pageConfig.onTargetsChange.call(fixture.page, { detail: { value: ["mother"] } });
    fixture.pageConfig.removeImage.call(fixture.page, { currentTarget: { dataset: { index: 0 } } });
    interactionPromises.push(Promise.resolve(fixture.pageConfig.remove.call(fixture.page)));
    assert.deepEqual(structuredClone(expectedState()), initialState);
  };

  const saving = fixture.pageConfig.save.call(fixture.page);

  assert.deepEqual(events, ["subscription.template-id", "permission"]);
  assert.equal(fixture.page.data.submitting, true);
  exerciseInteractions("权限阶段");

  permission.resolve(createNoticeSession());
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(events.includes("reminder.recordSubscription"));
  exerciseInteractions("登记阶段");

  record.resolve({});
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(events.includes("notice.create"));
  exerciseInteractions("保存阶段");
  assert.deepEqual(noticePayload, {
    ...clickedForm,
    eventTime: null,
    deadline: null,
    id: "",
    remindTime: new Date(2026, 8, 10, 8, 0).toISOString(),
  });
  assert.equal(events.includes("chooseMedia"), false);
  assert.equal(events.includes("remove.modal"), false);

  noticeSave.resolve({ id: "notice-id" });
  await saving;
  await Promise.all(interactionPromises);
  assert.equal(fixture.page.data.submitting, false);
  assert.equal(fixture.page.saveInProgress, false);
});

test("非法历史提醒时间加载后安全关闭且普通编辑不触发新提醒", async () => {
  const events = [];
  const modals = [];
  let updatePayload;
  const fixture = createNoticePage("notice-edit", {
    api: {
      callFunction(name, action, data) {
        events.push(`${name}.${action}`);
        if (name === "settings") return Promise.resolve({ settings: {} });
        if (name === "reminder" && action === "getStatus") return Promise.resolve({ enabled: true, templateId: "template-id", estimatedAvailableCount: 0, pendingCount: 0, blockedReason: "" });
        if (name === "notice" && action === "get") return Promise.resolve({
          _id: "notice-id",
          semester: "2026下",
          title: "旧标题",
          source: "班主任",
          category: "other",
          content: "正文",
          images: [],
          remindTime: "invalid-time",
          remindAdvance: [120],
          remindTargets: ["father"],
          reminderState: "materialized",
        });
        if (name === "notice" && action === "update") { updatePayload = structuredClone(data); return Promise.resolve({ id: "notice-id" }); }
        throw new Error(`不应调用：${name}.${action}`);
      },
      showError(error) { throw error; },
      uploadFile: async () => "cloud://image",
    },
    subscription: {
      requestReminderSubscription() {
        events.push("subscription.request");
        return Promise.resolve({ templateId: "template-id", decision: "accept", requestId: "subscription_request" });
      },
    },
    wx: {
      showToast() {}, showModal(options) { modals.push(options); }, navigateBack() {}, navigateTo() {}, previewImage() {},
    },
  });

  await fixture.pageConfig.onLoad.call(fixture.page, { id: "notice-id" });

  assert.equal(fixture.page.data.reminderEnabled, false);
  assert.equal(fixture.page.data.needsSubscription, false);
  fixture.pageConfig.onInput.call(fixture.page, { currentTarget: { dataset: { field: "title" } }, detail: { value: "新标题" } });
  await fixture.pageConfig.save.call(fixture.page);

  assert.equal(modals.length, 0);
  assert.equal(events.includes("subscription.request"), false);
  assert.equal(events.includes("reminder.recordSubscription"), false);
  assert.equal(updatePayload.title, "新标题");
  assert.equal(updatePayload.remindTime, null);
});

test("只有接受授权才登记订阅，拒绝限制过滤和关闭仍保存", async () => {
  for (const outcome of ["reject", "ban", "filter", "closed"]) {
    const events = [];
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
        requestReminderSubscription() {
          events.push("subscription.request");
          return outcome === "closed" ? Promise.reject(new Error("closed")) : Promise.resolve({ templateId: "template-id", decision: outcome, requestId: "subscription-request" });
        },
      },
    });
    prepareReminderSave(fixture);

    await fixture.pageConfig.save.call(fixture.page);

    assert.equal(events.includes("reminder.recordSubscription"), false, outcome);
    assert.equal(events.at(-1), "notice.create", outcome);
  }
});

test("接受授权后登记失败仍保存并显示指定提示", async () => {
  const events = [];
  const toasts = [];
  const logs = [];
  const secret = "record-token-secret";
  const fixture = createNoticePage("notice-edit", {
    api: {
      callFunction(name, action) {
        events.push(`${name}.${action}`);
        if (name === "reminder" && action === "recordSubscription") return Promise.reject(new Error(`登记失败 token=${secret}`));
        if (name === "notice" && action === "create") return Promise.resolve({ id: "notice-id" });
        throw new Error(`不应调用：${name}.${action}`);
      },
      showError(error) { throw error; },
      uploadFile: async () => "cloud://image",
    },
    subscription: { requestReminderSubscription: async () => ({ templateId: "template-id", decision: "accept", requestId: "subscription-request" }) },
    wx: { showToast(options) { toasts.push(options); }, showModal() {}, navigateBack() {}, navigateTo() {}, previewImage() {} },
    console: { error(...args) { logs.push(args); } },
  });
  prepareReminderSave(fixture);

  await fixture.pageConfig.save.call(fixture.page);

  assert.equal(events.join(","), "reminder.recordSubscription,notice.create");
  assert.deepEqual(JSON.parse(JSON.stringify(toasts)), [{ title: "通知已保存，微信提醒授权记录失败，请到设置页重试", icon: "none" }]);
  assert.equal(logs[0][0], "Reminder subscription record failed");
  assert.equal(JSON.stringify(logs).includes(secret), false);
});

test("确认新提醒版本后同步发起订阅授权并在持久化完成后释放保存锁", async () => {
  const events = [];
  const modalCalls = [];
  const update = createDeferred();
  const fixture = createNoticePage("notice-edit", {
    api: {
      callFunction(name, action) {
        events.push(`${name}.${action}`);
        if (name === "notice" && action === "update") return update.promise;
        throw new Error(`不应调用：${name}.${action}`);
      },
      showError(error) { throw error; },
      uploadFile: async () => "cloud://image",
    },
    subscription: { requestReminderSubscription() { events.push("subscription.request"); return Promise.resolve({ templateId: "template-id", decision: "reject", requestId: "subscription-request" }); } },
    wx: { showToast() {}, showModal(options) { modalCalls.push(options); }, navigateBack() {}, navigateTo() {}, previewImage() {} },
  });
  prepareReminderSave(fixture);
  fixture.page.data.id = "notice-id";
  fixture.page.data.remindDate = "2026-09-11";
  fixture.page.originalReminder = { remindTime: "2026-09-10T08:00:00.000Z", remindAdvance: [120], remindTargets: ["father"], reminderState: "materialized" };

  fixture.pageConfig.save.call(fixture.page);
  modalCalls[0].success({ confirm: true });

  assert.deepEqual(events, ["subscription.request"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.at(-1), "notice.update");
  update.resolve({ id: "notice-id" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.page.saveInProgress, false);
  assert.equal(fixture.page.data.submitting, false);
});

test("通知详情将历史畸形提醒字段显示为未设置并隐藏无效时间", async () => {
  const fixture = createNoticePage("notice-detail", {
    api: {
      callFunction() {
        return Promise.resolve({ _id: "notice-id", category: "other", remindTime: "invalid-time", remindAdvance: [999, 1440, 120], remindTargets: ["unknown"] });
      },
      showError() {},
      uploadFile: async () => "cloud://image",
    },
  });

  await fixture.pageConfig.onLoad.call(fixture.page, { id: "notice-id" });

  assert.equal(fixture.page.data.item.advanceText, "提前1天");
  assert.equal(fixture.page.data.item.targetText, "");
  assert.equal(fixture.page.data.item.hasReminder, false);
  assert.equal(fixture.page.data.item.remindTimeText, "");
});

test("通知详情缺失或无有效提前量时显示未设置", async () => {
  const fixture = createNoticePage("notice-detail", {
    api: {
      callFunction() { return Promise.resolve({ _id: "notice-id", category: "other", remindTime: "2026-09-10T08:00:00.000Z", remindAdvance: [999, 888], remindTargets: null }); },
      showError() {},
      uploadFile: async () => "cloud://image",
    },
  });

  await fixture.pageConfig.onLoad.call(fixture.page, { id: "notice-id" });

  assert.equal(fixture.page.data.item.advanceText, "未设置");
  assert.equal(fixture.page.data.item.hasReminder, true);
});

test("通知详情缺失提醒时间时不渲染提醒信息", async () => {
  const fixture = createNoticePage("notice-detail", {
    api: {
      callFunction() { return Promise.resolve({ _id: "notice-id", category: "other", remindTime: null, remindAdvance: [120], remindTargets: ["father"] }); },
      showError() {},
      uploadFile: async () => "cloud://image",
    },
  });

  await fixture.pageConfig.onLoad.call(fixture.page, { id: "notice-id" });

  assert.equal(fixture.page.data.item.hasReminder, false);
  assert.equal(fixture.page.data.item.remindTimeText, "");
});

test("通知详情编辑按最新会话权限复核", async () => {
  let session = createNoticeSession();
  const navigations = [];
  const toasts = [];
  const fixture = createNoticePage("notice-detail", {
    requireFamily: () => Promise.resolve(session),
    api: { callFunction() { return Promise.resolve({ _id: "notice-id", category: "other" }); }, showError() {}, uploadFile: async () => "cloud://image" },
    wx: { showToast(options) { toasts.push(options); }, showModal() {}, navigateBack() {}, navigateTo(options) { navigations.push(options); }, previewImage() {} },
  });

  await fixture.pageConfig.onLoad.call(fixture.page, { id: "notice-id" });
  session = { ...createNoticeSession(), user: { ...createNoticeSession().user, role: "child" } };
  await fixture.pageConfig.edit.call(fixture.page);

  assert.deepEqual(navigations, []);
  assert.deepEqual(JSON.parse(JSON.stringify(toasts)), [{ title: "孩子账号不能新增或编辑通知", icon: "none" }]);
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
      callFunction(name, action, payload) {
        assert.equal(`${name}.${action}`, "notice.get");
        assert.deepEqual(JSON.parse(JSON.stringify(payload)), { id: "notice-id" });
        return Promise.resolve({ _id: "notice-id", title: "家长会", source: "班主任", category: "other", remindTime: "2026-09-10T08:00:00.000Z", remindAdvance: [1440], remindTargets: ["father", "unknown"], images: ["cloud://image"] });
      },
      showError() {},
      uploadFile: async () => "cloud://image",
    },
  });

  await fixture.pageConfig.onLoad.call(fixture.page, { id: "notice-id" });

  assert.equal(fixture.page.data.item.title, "家长会");
  assert.equal(fixture.page.data.item.source, "班主任");
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

test("系统阻断时设置页展示阻断原因并禁止增加提醒次数", async () => {
  const fixture = loadSettingsPage({
    api: {
      callFunction(name) {
        return Promise.resolve(name === "settings"
          ? createSettingsData()
          : { ...createReminderStatus(), enabled: false, blockedReason: "SYSTEM_BLOCKED" });
      },
      showError() {},
    },
  });

  await fixture.pageConfig.load.call(fixture.page);

  assert.equal(fixture.page.data.reminderStatusText, "提醒功能已阻断");
  assert.equal(fixture.page.data.reminderStatusDetail, "微信订阅消息能力或模板已停用，请联系管理员处理");
  assert.equal(fixture.page.data.reminderStatus.enabled, false);
});

test("设置页提醒状态错误日志会脱敏凭据", async () => {
  const logs = [];
  const secret = "settings-token-secret";
  const fixture = loadSettingsPage({
    api: {
      callFunction(name) {
        if (name === "settings") return Promise.resolve(createSettingsData());
        return Promise.reject(new Error(`提醒状态读取失败 token=${secret}`));
      },
      showError() {},
    },
    console: { error(...args) { logs.push(args); } },
  });

  await fixture.pageConfig.load.call(fixture.page);

  assert.equal(logs[0][0], "Reminder status request failed");
  assert.equal(JSON.stringify(logs).includes(secret), false);
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

test("编辑通知加载期间拒绝保存和删除副作用", async () => {
  const events = [];
  const modals = [];
  const notice = createDeferred();
  const fixture = createNoticePage("notice-edit", {
    api: {
      callFunction(name, action) {
        events.push(`${name}.${action}`);
        if (name === "settings") return Promise.resolve({ settings: {} });
        if (name === "reminder") return Promise.resolve(createReminderStatus());
        if (name === "notice" && action === "get") return notice.promise;
        if (name === "notice") throw new Error("初始化期间不应写入通知");
        throw new Error(`不应调用：${name}.${action}`);
      },
      showError(error) { throw error; },
      uploadFile: async () => "cloud://image",
    },
    wx: { showToast() {}, showModal(options) { modals.push(options); }, navigateBack() {}, navigateTo() {}, previewImage() {} },
    subscription: { requestReminderSubscription() { events.push("subscription.request"); return Promise.resolve({ decision: "accept" }); } },
  });

  const loading = fixture.pageConfig.onLoad.call(fixture.page, { id: "notice-id" });
  await new Promise((resolve) => setImmediate(resolve));
  fixture.page.data.form = { ...fixture.page.data.form, title: "家长会", remindAdvance: [120], remindTargets: ["father"] };
  fixture.page.data.reminderEnabled = true;
  fixture.page.data.reminderStatus = createReminderStatus();
  fixture.pageConfig.save.call(fixture.page);
  await fixture.pageConfig.remove.call(fixture.page);

  assert.equal(fixture.page.data.initializing, true);
  assert.deepEqual(modals, []);
  assert.deepEqual(events, ["settings.get", "reminder.getStatus", "notice.get"]);

  notice.resolve({ _id: "notice-id", category: "other" });
  await loading;
  assert.equal(fixture.page.data.initializing, false);
});

test("编辑加载失败后删除和保存均不会写入", async () => {
  const calls = [];
  const modals = [];
  const fixture = createNoticePage("notice-edit", {
    api: {
      callFunction(name, action) {
        calls.push(`${name}.${action}`);
        if (name === "settings") return Promise.resolve({ settings: {} });
        if (name === "reminder") return Promise.resolve(createReminderStatus());
        if (name === "notice" && action === "get") return Promise.reject(new Error("通知读取失败"));
        throw new Error(`加载失败后不应调用：${name}.${action}`);
      },
      showError() {},
      uploadFile: async () => "cloud://image",
    },
    wx: { showToast() {}, showModal(options) { modals.push(options); }, navigateBack() {}, navigateTo() {}, previewImage() {} },
  });

  await fixture.pageConfig.onLoad.call(fixture.page, { id: "notice-id" });
  fixture.page.data.form.title = "家长会";
  fixture.pageConfig.save.call(fixture.page);
  await fixture.pageConfig.remove.call(fixture.page);

  assert.equal(fixture.page.data.initializationFailed, true);
  assert.deepEqual(modals, []);
  assert.deepEqual(calls, ["settings.get", "reminder.getStatus", "notice.get"]);
});

test("原型链关系键不能触发订阅授权", () => {
  const input = {
    reminderEnabled: true,
    estimatedAvailableCount: 0,
    templateId: "template-id",
  };

  for (const relation of ["constructor", "toString", "__proto__"]) {
    assert.equal(shouldRequestSubscription({ ...input, currentRelation: relation, remindTargets: [relation] }), false, relation);
  }
  assert.equal(shouldRequestSubscription({ ...input, currentRelation: "father", remindTargets: ["father"] }), true);
});

test("通知详情忽略原型链关系键并保留合法关系", async () => {
  const fixture = createNoticePage("notice-detail", {
    api: {
      callFunction() { return Promise.resolve({ _id: "notice-id", category: "other", remindTargets: ["constructor", "toString", "__proto__", "father"] }); },
      showError() {},
      uploadFile: async () => "cloud://image",
    },
  });

  await fixture.pageConfig.onLoad.call(fixture.page, { id: "notice-id" });

  assert.equal(fixture.page.data.item.targetText, "爸爸");
});

test("提醒状态错误日志不包含敏感凭据", async () => {
  const logs = [];
  const secretValues = ["token-secret", "sid-private", "hunter2", "server-secret", "api-key-secret", "o12345678901234567890123456789012"];
  const fixture = createNoticePage("notice-edit", {
    api: {
      callFunction(name) {
        if (name === "settings") return Promise.resolve({ settings: {} });
        return Promise.reject({
          message: `状态失败 token=${secretValues[0]} Cookie: ${secretValues[1]} password=${secretValues[2]} secret=${secretValues[3]} key=${secretValues[4]} openid=${secretValues[5]}`,
          code: "STATUS_FAILED",
        });
      },
      showError() {},
      uploadFile: async () => "cloud://image",
    },
    console: { error(...args) { logs.push(args); } },
  });

  await fixture.pageConfig.onLoad.call(fixture.page, {});

  assert.equal(logs[0][0], "Reminder status request failed");
  assert.ok(logs[0][1].message.includes("状态失败"));
  assert.ok(logs[0][1].message.length <= 160);
  for (const value of secretValues) assert.equal(logs[0][1].message.includes(value), false, value);
});

test("提醒状态错误日志脱敏复合键和 JSON 查询日志格式", async () => {
  const cases = [
    { message: "提醒状态读取失败\n{\"token\":\"json-token-secret\"}", secrets: ["json-token-secret"] },
    { message: "提醒状态读取失败 ?access_token=query-token-secret&action=getStatus", secrets: ["query-token-secret"] },
    { message: "提醒状态读取失败 refreshToken:refresh-token-secret apiKey=api-key-secret clientSecret=client-secret-value", secrets: ["refresh-token-secret", "api-key-secret", "client-secret-value"] },
    { message: "提醒状态读取失败 {\"password\":\"password-secret\",\"cookie\":\"cookie-secret\",\"openid\":\"openid-secret\"}", secrets: ["password-secret", "cookie-secret", "openid-secret"] },
  ];

  for (const item of cases) {
    const logs = [];
    const fixture = createNoticePage("notice-edit", {
      api: {
        callFunction(name) {
          if (name === "settings") return Promise.resolve({ settings: {} });
          return Promise.reject({ message: item.message, code: "STATUS_FAILED" });
        },
        showError() {},
        uploadFile: async () => "cloud://image",
      },
      console: { error(...args) { logs.push(args); } },
    });

    await fixture.pageConfig.onLoad.call(fixture.page, {});

    assert.equal(logs[0][0], "Reminder status request failed");
    assert.ok(logs[0][1].message.includes("提醒状态读取失败"));
    assert.equal(logs[0][1].message.includes("\n"), false);
    assert.ok(logs[0][1].message.length <= 160);
    assert.equal(logs[0][1].code, "STATUS_FAILED");
    for (const secret of item.secrets) assert.equal(logs[0][1].message.includes(secret), false, secret);
  }
});

test("通知详情将非日期提醒时间视为未设置", async () => {
  for (const value of [0, false, [], {}, NaN, Infinity]) {
    const fixture = createNoticePage("notice-detail", {
      api: {
        callFunction() { return Promise.resolve({ _id: "notice-id", category: "other", remindTime: value, remindAdvance: [120] }); },
        showError() {},
        uploadFile: async () => "cloud://image",
      },
    });

    await fixture.pageConfig.onLoad.call(fixture.page, { id: "notice-id" });

    assert.equal(fixture.page.data.item.hasReminder, false, String(value));
    assert.equal(fixture.page.data.item.remindTimeText, "", String(value));
  }
});

test("通知详情仍显示合法的日期、字符串和正数时间戳", async () => {
  for (const value of [new Date("2026-09-10T08:00:00.000Z"), "2026-09-10T08:00:00.000Z", 1788796800000]) {
    const fixture = createNoticePage("notice-detail", {
      api: {
        callFunction() { return Promise.resolve({ _id: "notice-id", category: "other", remindTime: value, remindAdvance: [120] }); },
        showError() {},
        uploadFile: async () => "cloud://image",
      },
    });

    await fixture.pageConfig.onLoad.call(fixture.page, { id: "notice-id" });

    assert.equal(fixture.page.data.item.hasReminder, true, String(value));
    assert.notEqual(fixture.page.data.item.remindTimeText, "", String(value));
  }
});

test("提醒状态不可用时保存通知且不请求订阅", async () => {
  const events = [];
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
    subscription: { requestReminderSubscription() { events.push("subscription.request"); return Promise.resolve({ decision: "accept" }); } },
  });
  prepareReminderSave(fixture);
  fixture.page.data.reminderStatus = { enabled: false, templateId: "template-id", estimatedAvailableCount: 0, pendingCount: 0, blockedReason: "STATUS_UNAVAILABLE" };

  await fixture.pageConfig.save.call(fixture.page);

  assert.deepEqual(events, ["notice.create"]);
  assert.equal(fixture.page.saveInProgress, false);
  assert.equal(fixture.page.data.submitting, false);
});
