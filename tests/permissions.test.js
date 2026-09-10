const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const { canPerform } = require("../miniprogram/utils/permissions");

test("普通成员只能删除自己录入的作业", () => {
  assert.equal(canPerform("member", "deleteHomework", { ownsResource: true }), true);
  assert.equal(canPerform("member", "deleteHomework", { ownsResource: false }), false);
});

test("孩子只能执行允许的协作动作", () => {
  assert.equal(canPerform("child", "toggleHomework", {}), true);
  assert.equal(canPerform("child", "createHomework", {}), false);
});

test("普通成员仅在创建者开启后修改普通设置", () => {
  assert.equal(canPerform("member", "updateSettings", { allowMemberEditSettings: true }), true);
  assert.equal(canPerform("member", "updateSettings", { allowMemberEditSettings: false }), false);
});

test("只有创建者可以管理家庭成员", () => {
  assert.equal(canPerform("creator", "manageMembers", {}), true);
  assert.equal(canPerform("member", "manageMembers", {}), false);
});

function setByPath(target, key, value) {
  const segments = key.match(/[^.[\]]+/g);
  let current = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (current[segment] === undefined) {
      current[segment] = /^\d+$/.test(segments[index + 1]) ? [] : {};
    }
    current = current[segment];
  }
  current[segments.at(-1)] = value;
}

function loadPage(relativePath, overrides = {}) {
  const sourcePath = path.resolve(__dirname, "..", relativePath);
  const source = fs.readFileSync(sourcePath, "utf8");
  const requireFromPage = createRequire(sourcePath);
  let pageConfig;
  const callFunctionCalls = [];
  const uploadFileCalls = [];
  const navigateToCalls = [];
  const navigateBackCalls = [];
  const showModalCalls = [];
  const chooseMediaCalls = [];
  const toastCalls = [];
  const showErrorCalls = [];
  const permissionCalls = [];
  let session = Object.prototype.hasOwnProperty.call(overrides, "session") ? overrides.session : {
    user: { role: "child", familyId: "family-1" },
    family: { currentSemester: "2026下", educationStage: "junior_high" },
  };
  const callFunction = async (...args) => {
    callFunctionCalls.push(args);
    if (args[0] === "settings") return { subjects: ["语文"] };
    if (args[0] === "homework") return { items: [], hasMore: false };
    if (args[0] === "notice") return { items: [], hasMore: false };
    if (args[0] === "plan") return { items: [] };
    throw new Error(`Unexpected cloud function: ${args[0]}`);
  };
  const uploadFile = async (...args) => {
    uploadFileCalls.push(args);
    return "cloud://file";
  };
  const wx = {
    navigateTo: (options) => navigateToCalls.push(options),
    navigateBack: () => navigateBackCalls.push(true),
    showToast: (options) => toastCalls.push(options),
    showModal: (options) => showModalCalls.push(options),
    chooseMedia: async (options) => {
      chooseMediaCalls.push(options);
      if (overrides.chooseMedia) return overrides.chooseMedia(options);
      return { tempFiles: [] };
    },
    stopPullDownRefresh() {},
  };
  const context = vm.createContext({
    Page(config) { pageConfig = config; },
    wx,
    console,
    Date,
    Promise,
    setTimeout,
    clearTimeout,
    require(request) {
      if (request === "../../utils/api") return { callFunction, showError(...args) { showErrorCalls.push(args); }, uploadFile };
      if (request === "../../utils/session") return { requireFamily: async () => (overrides.requireFamily ? overrides.requireFamily() : session) };
      if (request === "../../utils/permissions") {
        const permissions = requireFromPage(request);
        return { ...permissions, canPerform(...args) { permissionCalls.push(args); return permissions.canPerform(...args); } };
      }
      return requireFromPage(request);
    },
  });
  vm.runInContext(source, context, { filename: sourcePath });
  const page = {
    data: JSON.parse(JSON.stringify(pageConfig.data)),
    setData(values) {
      for (const [key, value] of Object.entries(values)) setByPath(this.data, key, value);
    },
  };
  for (const [name, value] of Object.entries(pageConfig)) {
    if (typeof value === "function") page[name] = value.bind(page);
  }
  return { page, callFunctionCalls, uploadFileCalls, navigateToCalls, navigateBackCalls, showModalCalls, chooseMediaCalls, toastCalls, showErrorCalls, permissionCalls, setSession(value) { session = value; } };
}

const restrictedActions = [
  "createHomework",
  "updateHomework",
  "deleteHomework",
  "manageNotice",
  "managePlan",
];

test("孩子不能执行作业通知和计划的维护动作", () => {
  for (const action of restrictedActions) {
    assert.equal(canPerform("child", action), false);
  }
});

test("维护动作默认拒绝缺失和未知角色", () => {
  for (const role of [undefined, null, "unknown"]) {
    for (const action of [...restrictedActions, "requestDeleteHomework"]) {
      assert.equal(canPerform(role, action), false, `${role}: ${action}`);
    }
  }
});

test("作业删除请求只允许创建者和普通成员发起", () => {
  assert.equal(canPerform("creator", "requestDeleteHomework"), true);
  assert.equal(canPerform("member", "requestDeleteHomework"), true);
  assert.equal(canPerform("child", "requestDeleteHomework"), false);
  assert.equal(canPerform(undefined, "requestDeleteHomework"), false);
  assert.equal(canPerform("unknown", "requestDeleteHomework"), false);
  assert.equal(canPerform("member", "deleteHomework"), false);
});

const listPages = [
  { path: "miniprogram/pages/homework-list/homework-list.js", handlers: ["createHomework"] },
  { path: "miniprogram/pages/notice-list/notice-list.js", handlers: ["create"], readonlyHandler: "view" },
  { path: "miniprogram/pages/plan-list/plan-list.js", handlers: ["create", "edit"] },
];

test("孩子会话加载后列表页隐藏维护入口且事件不会跳转", async () => {
  for (const item of listPages) {
    const fixture = loadPage(item.path);
    await fixture.page.onShow();
    assert.equal(fixture.page.data.canManage, false, item.path);
    for (const handler of item.handlers) {
      fixture.page[handler]({ currentTarget: { dataset: { id: "resource-1" } } });
    }
    assert.equal(fixture.navigateToCalls.length, 0, item.path);
  }
});

test("孩子账号可以从通知列表进入只读详情", async () => {
  const fixture = loadPage("miniprogram/pages/notice-list/notice-list.js");

  await fixture.page.onShow();
  fixture.page.view({ currentTarget: { dataset: { id: "notice-1" } } });

  assert.equal(fixture.navigateToCalls[0].url, "/pages/notice-detail/notice-detail?id=notice-1");
});

test("成人会话加载后列表页允许维护入口", async () => {
  for (const role of ["creator", "member"]) {
    for (const item of listPages) {
      const fixture = loadPage(item.path, {
        session: {
          user: { role, familyId: "family-1" },
          family: { currentSemester: "2026下", educationStage: "junior_high" },
        },
      });
      await fixture.page.onShow();
      assert.equal(fixture.page.data.canManage, true, `${role}: ${item.path}`);
      fixture.page[item.handlers[0]]({ currentTarget: { dataset: { id: "resource-1" } } });
      assert.equal(fixture.navigateToCalls.length, 1, `${role}: ${item.path}`);
    }
  }
});

test("列表会话失效时清除维护状态且事件不会跳转", async () => {
  for (const item of listPages) {
    const fixture = loadPage(item.path, {
      session: {
        user: { role: "creator", familyId: "family-1" },
        family: { currentSemester: "2026下", educationStage: "junior_high" },
      },
    });
    await fixture.page.onShow();
    fixture.setSession(null);
    await fixture.page.onShow();
    assert.equal(fixture.page.currentUser, null, item.path);
    assert.equal(fixture.page.data.canManage, false, item.path);
    fixture.page[item.handlers[0]]({ currentTarget: { dataset: { id: "resource-1" } } });
    assert.equal(fixture.navigateToCalls.length, 0, item.path);
  }
});

test("孩子直接加载维护页时立即返回且不读取业务详情", async () => {
  const paths = [
    "miniprogram/pages/homework-edit/homework-edit.js",
    "miniprogram/pages/notice-edit/notice-edit.js",
    "miniprogram/pages/plan-edit/plan-edit.js",
  ];
  for (const pagePath of paths) {
    const fixture = loadPage(pagePath);
    await fixture.page.onLoad({ id: "resource-1" });
    assert.equal(fixture.navigateBackCalls.length, 1, pagePath);
    assert.equal(fixture.callFunctionCalls.length, 0, pagePath);
  }
});

test("编辑页仅对存在但无权的会话返回上一页", async () => {
  const paths = [
    "miniprogram/pages/homework-edit/homework-edit.js",
    "miniprogram/pages/notice-edit/notice-edit.js",
    "miniprogram/pages/plan-edit/plan-edit.js",
  ];
  for (const role of ["child", "unknown"]) {
    for (const pagePath of paths) {
      const fixture = loadPage(pagePath, {
        session: { user: { role, familyId: "family-1" }, family: { currentSemester: "2026下", educationStage: "junior_high" } },
      });
      await fixture.page.onLoad({ id: "resource-1" });
      assert.equal(fixture.navigateBackCalls.length, 1, `${role}: ${pagePath}`);
      assert.equal(fixture.callFunctionCalls.length, 0, `${role}: ${pagePath}`);
    }
  }
  for (const pagePath of paths) {
    const fixture = loadPage(pagePath, { session: null });
    await fixture.page.onLoad({ id: "resource-1" });
    assert.equal(fixture.navigateBackCalls.length, 0, pagePath);
    assert.equal(fixture.callFunctionCalls.length, 0, pagePath);
  }
});

test("孩子和未知用户不能直接编辑作业详情", async () => {
  for (const role of ["child", "unknown"]) {
    const fixture = loadPage("miniprogram/pages/homework-detail/homework-detail.js", {
      session: { user: { role, familyId: "family-1" }, family: { currentSemester: "2026下", educationStage: "junior_high" } },
    });
    fixture.page.currentUser = { role };
    await fixture.page.edit();
    assert.equal(fixture.navigateToCalls.length, 0, role);
  }
});

test("作业详情编辑根据最新会话拒绝降级并清理空会话", async () => {
  for (const session of [
    { user: { role: "child", familyId: "family-1" }, family: { currentSemester: "2026下", educationStage: "junior_high" } },
    { user: { role: "unknown", familyId: "family-1" }, family: { currentSemester: "2026下", educationStage: "junior_high" } },
    null,
  ]) {
    const fixture = loadPage("miniprogram/pages/homework-detail/homework-detail.js", { session });
    fixture.page.currentUser = { role: "creator", familyId: "family-1" };
    fixture.page.setData({ canEdit: true });
    await fixture.page.edit();
    assert.equal(fixture.navigateToCalls.length, 0);
    if (!session) {
      assert.equal(fixture.page.currentUser, null);
      assert.equal(fixture.page.data.canEdit, false);
    }
  }
});

test("作业详情显示时会在会话失效后清理维护状态", async () => {
  const fixture = loadPage("miniprogram/pages/homework-detail/homework-detail.js", {
    session: { user: { role: "creator", familyId: "family-1" }, family: { currentSemester: "2026下", educationStage: "junior_high" } },
  });
  fixture.page.setData({ id: "resource-1" });
  await fixture.page.onShow();
  assert.equal(fixture.page.currentUser.role, "creator");
  fixture.setSession(null);
  await fixture.page.onShow();
  assert.equal(fixture.page.currentUser, null);
  assert.equal(fixture.page.data.canEdit, false);
});

test("作业详情删除使用请求动作且不伪造资源所有权", async () => {
  for (const role of ["creator", "member"]) {
    const fixture = loadPage("miniprogram/pages/homework-detail/homework-detail.js", {
      session: { user: { role, familyId: "family-1" }, family: { currentSemester: "2026下", educationStage: "junior_high" } },
    });
    await fixture.page.remove();
    assert.equal(fixture.showModalCalls.length, 1, role);
    const permissionCall = fixture.permissionCalls.at(-1);
    assert.equal(permissionCall[1], "requestDeleteHomework", role);
    assert.notEqual(permissionCall[2] && permissionCall[2].ownsResource, true, role);
  }
  for (const role of ["child", "unknown", null]) {
    const session = role === null ? null : { user: { role, familyId: "family-1" }, family: { currentSemester: "2026下", educationStage: "junior_high" } };
    const fixture = loadPage("miniprogram/pages/homework-detail/homework-detail.js", { session });
    await fixture.page.remove();
    assert.equal(fixture.showModalCalls.length, 0, String(role));
  }
});

test("孩子触发上传保存删除时不会产生外部副作用", async () => {
  const homeworkEdit = loadPage("miniprogram/pages/homework-edit/homework-edit.js");
  homeworkEdit.page.currentUser = { role: "child" };
  await homeworkEdit.page.chooseMedia();
  await homeworkEdit.page.save();
  assert.deepEqual([homeworkEdit.chooseMediaCalls.length, homeworkEdit.uploadFileCalls.length, homeworkEdit.callFunctionCalls.length], [0, 0, 0]);

  const homeworkDetail = loadPage("miniprogram/pages/homework-detail/homework-detail.js");
  homeworkDetail.page.currentUser = { role: "child" };
  await homeworkDetail.page.remove();
  assert.deepEqual([homeworkDetail.showModalCalls.length, homeworkDetail.callFunctionCalls.length], [0, 0]);

  const noticeEdit = loadPage("miniprogram/pages/notice-edit/notice-edit.js");
  noticeEdit.page.currentUser = { role: "child" };
  await noticeEdit.page.chooseImages();
  await noticeEdit.page.save();
  await noticeEdit.page.remove();
  assert.deepEqual([noticeEdit.chooseMediaCalls.length, noticeEdit.uploadFileCalls.length, noticeEdit.showModalCalls.length, noticeEdit.callFunctionCalls.length], [0, 0, 0, 0]);

  const planEdit = loadPage("miniprogram/pages/plan-edit/plan-edit.js");
  planEdit.page.currentUser = { role: "child" };
  await planEdit.page.save();
  await planEdit.page.remove();
  assert.deepEqual([planEdit.showModalCalls.length, planEdit.callFunctionCalls.length], [0, 0]);

  assert.equal(homeworkEdit.toastCalls.at(-1).icon, "none");
  assert.equal(noticeEdit.toastCalls.at(-1).icon, "none");
  assert.equal(planEdit.toastCalls.at(-1).icon, "none");
});

test("上传前会使用最新会话拒绝降级和失效账号", async () => {
  for (const item of [
    { path: "miniprogram/pages/homework-edit/homework-edit.js", handler: "chooseMedia" },
    { path: "miniprogram/pages/notice-edit/notice-edit.js", handler: "chooseImages" },
  ]) {
    for (const session of [
      { user: { role: "child", familyId: "family-1" }, family: { currentSemester: "2026下", educationStage: "junior_high" } },
      null,
    ]) {
      const fixture = loadPage(item.path, { session });
      fixture.page.currentUser = { role: "creator", familyId: "family-1" };
      await fixture.page[item.handler]();
      assert.deepEqual([fixture.chooseMediaCalls.length, fixture.uploadFileCalls.length], [0, 0], item.path);
    }
  }
});

test("媒体选择期间账号降级时不会上传文件", async () => {
  for (const item of [
    { path: "miniprogram/pages/homework-edit/homework-edit.js", handler: "chooseMedia", tempFile: { fileType: "image", size: 1, tempFilePath: "image.jpg" } },
    { path: "miniprogram/pages/notice-edit/notice-edit.js", handler: "chooseImages", tempFile: { fileType: "image", size: 1, tempFilePath: "image.jpg" } },
  ]) {
    const fixture = loadPage(item.path, {
      session: { user: { role: "creator", familyId: "family-1" }, family: { currentSemester: "2026下", educationStage: "junior_high" } },
      chooseMedia: async () => {
        fixture.setSession({ user: { role: "child", familyId: "family-1" }, family: { currentSemester: "2026下", educationStage: "junior_high" } });
        return { tempFiles: [item.tempFile] };
      },
    });
    fixture.page.currentUser = { role: "creator", familyId: "family-1" };
    await fixture.page[item.handler]();
    assert.equal(fixture.uploadFileCalls.length, 0, item.path);
  }
});

test("上传使用媒体选择返回后的最新家庭标识", async () => {
  for (const item of [
    { path: "miniprogram/pages/homework-edit/homework-edit.js", handler: "chooseMedia", tempFile: { fileType: "image", size: 1, tempFilePath: "image.jpg" } },
    { path: "miniprogram/pages/notice-edit/notice-edit.js", handler: "chooseImages", tempFile: { fileType: "image", size: 1, tempFilePath: "image.jpg" } },
  ]) {
    const fixture = loadPage(item.path, {
      session: { user: { role: "creator", familyId: "family-old" }, family: { currentSemester: "2026下", educationStage: "junior_high" } },
      chooseMedia: async () => {
        fixture.setSession({ user: { role: "creator", familyId: "family-new" }, family: { currentSemester: "2026下", educationStage: "junior_high" } });
        return { tempFiles: [item.tempFile] };
      },
    });
    await fixture.page[item.handler]();
    assert.equal(fixture.uploadFileCalls.length, 1, item.path);
    assert.match(fixture.uploadFileCalls[0][0], /family-new/);
    assert.doesNotMatch(fixture.uploadFileCalls[0][0], /family-old/);
  }
});

test("第二次上传权限刷新完成前不会设置上传状态或上传", async () => {
  for (const item of [
    { path: "miniprogram/pages/homework-edit/homework-edit.js", handler: "chooseMedia", tempFile: { fileType: "image", size: 1, tempFilePath: "image.jpg" } },
    { path: "miniprogram/pages/notice-edit/notice-edit.js", handler: "chooseImages", tempFile: { fileType: "image", size: 1, tempFilePath: "image.jpg" } },
  ]) {
    let resolveSession;
    let reachedSecondRefresh;
    let sessionCalls = 0;
    const refreshedSession = new Promise((resolve) => { resolveSession = resolve; });
    const secondRefreshReached = new Promise((resolve) => { reachedSecondRefresh = resolve; });
    const fixture = loadPage(item.path, {
      requireFamily: async () => {
        sessionCalls += 1;
        if (sessionCalls === 1) return { user: { role: "creator", familyId: "family-1" }, family: { currentSemester: "2026下", educationStage: "junior_high" } };
        reachedSecondRefresh();
        return refreshedSession;
      },
      chooseMedia: async () => ({ tempFiles: [item.tempFile] }),
    });
    const uploadPromise = fixture.page[item.handler]();
    await secondRefreshReached;
    assert.equal(sessionCalls, 2, item.path);
    assert.equal(fixture.page.data.uploading, false, item.path);
    assert.equal(fixture.uploadFileCalls.length, 0, item.path);
    resolveSession({ user: { role: "child", familyId: "family-1" }, family: { currentSemester: "2026下", educationStage: "junior_high" } });
    await uploadPromise;
    assert.equal(fixture.uploadFileCalls.length, 0, item.path);
  }
});

test("权限刷新等待期间保存操作只提交一次", async () => {
  const fixtures = [
    { path: "miniprogram/pages/homework-edit/homework-edit.js", domain: "homework", prepare(page) { page.setData({ "form.subject": "语文", "form.title": "作业" }); } },
    { path: "miniprogram/pages/notice-edit/notice-edit.js", domain: "notice", prepare(page) { page.setData({ "form.title": "通知" }); } },
    { path: "miniprogram/pages/plan-edit/plan-edit.js", domain: "plan", prepare(page) { page.setData({ "form.title": "计划", "form.items": [{ text: "子任务", isDone: false, priority: "medium" }] }); } },
  ];
  for (const item of fixtures) {
    let resolveSession;
    const sessionPromise = new Promise((resolve) => { resolveSession = resolve; });
    const fixture = loadPage(item.path, { requireFamily: async () => sessionPromise });
    item.prepare(fixture.page);
    const firstSave = fixture.page.save();
    const secondSave = fixture.page.save();
    assert.equal(fixture.page.data.submitting, true, item.path);
    resolveSession({ user: { role: "creator", familyId: "family-1" }, family: { currentSemester: "2026下", educationStage: "junior_high" } });
    await Promise.all([firstSave, secondSave]);
    assert.equal(fixture.callFunctionCalls.filter((args) => args[0] === item.domain && args[1] === "create").length, 1, item.path);
    assert.equal(fixture.page.data.submitting, false, item.path);
    assert.equal(fixture.page.saveInProgress, false, item.path);
  }
});

test("会话请求失败时页面副作用被安全拒绝", async () => {
  const rejection = new Error("session unavailable");
  const saveFixtures = [
    { path: "miniprogram/pages/homework-edit/homework-edit.js", prepare(page) { page.setData({ "form.subject": "语文", "form.title": "作业" }); } },
    { path: "miniprogram/pages/notice-edit/notice-edit.js", prepare(page) { page.setData({ "form.title": "通知" }); } },
    { path: "miniprogram/pages/plan-edit/plan-edit.js", prepare(page) { page.setData({ "form.title": "计划", "form.items": [{ text: "子任务", isDone: false, priority: "medium" }] }); } },
  ];
  for (const item of saveFixtures) {
    const fixture = loadPage(item.path, { requireFamily: async () => { throw rejection; } });
    fixture.page.currentUser = { role: "creator", familyId: "family-old" };
    fixture.page.familyId = "family-old";
    item.prepare(fixture.page);
    await assert.doesNotReject(fixture.page.save(), item.path);
    assert.equal(fixture.callFunctionCalls.length, 0, item.path);
    assert.equal(fixture.showErrorCalls.length, 1, item.path);
    assert.equal(fixture.page.data.submitting, false, item.path);
    assert.equal(fixture.page.currentUser, null, item.path);
  }
  for (const item of [
    { path: "miniprogram/pages/homework-edit/homework-edit.js", handler: "chooseMedia" },
    { path: "miniprogram/pages/notice-edit/notice-edit.js", handler: "chooseImages" },
  ]) {
    const fixture = loadPage(item.path, { requireFamily: async () => { throw rejection; } });
    fixture.page.currentUser = { role: "creator", familyId: "family-old" };
    fixture.page.familyId = "family-old";
    fixture.page.setData({ uploading: true });
    await assert.doesNotReject(fixture.page[item.handler](), item.path);
    assert.deepEqual([fixture.chooseMediaCalls.length, fixture.uploadFileCalls.length], [0, 0], item.path);
    assert.equal(fixture.showErrorCalls.length, 1, item.path);
    assert.equal(fixture.page.data.uploading, false, item.path);
    assert.equal(fixture.page.currentUser, null, item.path);
    assert.equal(fixture.page.familyId, null, item.path);
  }
  const detail = loadPage("miniprogram/pages/homework-detail/homework-detail.js", { requireFamily: async () => { throw rejection; } });
  detail.page.currentUser = { role: "creator", familyId: "family-old" };
  detail.page.setData({ id: "resource-1", canEdit: true });
  await assert.doesNotReject(detail.page.onShow());
  await assert.doesNotReject(detail.page.edit());
  await assert.doesNotReject(detail.page.remove());
  assert.deepEqual([detail.callFunctionCalls.length, detail.navigateToCalls.length, detail.showModalCalls.length], [0, 0, 0]);
  assert.equal(detail.showErrorCalls.length, 3);
  assert.equal(detail.page.currentUser, null);
  assert.equal(detail.page.data.canEdit, false);
});

test("保存和删除使用最新会话拒绝降级账号", async () => {
  const saveFixtures = [
    { path: "miniprogram/pages/homework-edit/homework-edit.js", prepare(page) { page.setData({ "form.subject": "语文", "form.title": "作业" }); } },
    { path: "miniprogram/pages/notice-edit/notice-edit.js", prepare(page) { page.setData({ "form.title": "通知" }); } },
    { path: "miniprogram/pages/plan-edit/plan-edit.js", prepare(page) { page.setData({ "form.title": "计划", "form.items": [{ text: "子任务", isDone: false, priority: "medium" }] }); } },
  ];
  for (const item of saveFixtures) {
    const fixture = loadPage(item.path, { session: { user: { role: "child", familyId: "family-1" }, family: { currentSemester: "2026下", educationStage: "junior_high" } } });
    fixture.page.currentUser = { role: "creator", familyId: "family-1" };
    item.prepare(fixture.page);
    await fixture.page.save();
    assert.equal(fixture.callFunctionCalls.length, 0, item.path);
  }
  for (const path of [
    "miniprogram/pages/homework-detail/homework-detail.js",
    "miniprogram/pages/notice-edit/notice-edit.js",
    "miniprogram/pages/plan-edit/plan-edit.js",
  ]) {
    const fixture = loadPage(path, { session: { user: { role: "child", familyId: "family-1" }, family: { currentSemester: "2026下", educationStage: "junior_high" } } });
    fixture.page.currentUser = { role: "creator", familyId: "family-1" };
    await fixture.page.remove();
    assert.deepEqual([fixture.callFunctionCalls.length, fixture.showModalCalls.length], [0, 0], path);
  }
});

test("列表页会话刷新异常时清理维护状态并拒绝导航", async () => {
  for (const item of [
    { path: "miniprogram/pages/homework-list/homework-list.js", handlers: ["createHomework"] },
    { path: "miniprogram/pages/notice-list/notice-list.js", handlers: ["create"] },
    { path: "miniprogram/pages/plan-list/plan-list.js", handlers: ["create", "edit"] },
  ]) {
    let sessionCalls = 0;
    const rejection = new Error("session unavailable");
    const fixture = loadPage(item.path, {
      requireFamily: async () => {
        sessionCalls += 1;
        if (sessionCalls === 1) {
          return {
            user: { role: "creator", familyId: "family-1" },
            family: { currentSemester: "2026下", educationStage: "junior_high" },
          };
        }
        throw rejection;
      },
    });

    await fixture.page.onShow();
    assert.equal(fixture.page.data.canManage, true, item.path);
    await assert.doesNotReject(fixture.page.onShow(), item.path);
    assert.equal(fixture.page.currentUser, null, item.path);
    assert.equal(fixture.page.data.canManage, false, item.path);
    assert.deepEqual(fixture.showErrorCalls, [[rejection, "身份校验失败，请稍后重试"]], item.path);
    for (const handler of item.handlers) {
      fixture.page[handler]({ currentTarget: { dataset: { id: "resource-1" } } });
      assert.equal(fixture.navigateToCalls.length, 0, `${item.path}: ${handler}`);
    }
  }
});

test("删除确认后按最新会话拒绝失效权限和会话异常", async () => {
  const rejection = new Error("session unavailable");
  const fixtures = [
    {
      path: "miniprogram/pages/homework-detail/homework-detail.js",
      domain: "homework",
      childToast: "孩子账号不能删除作业",
    },
    {
      path: "miniprogram/pages/notice-edit/notice-edit.js",
      domain: "notice",
      childToast: "孩子账号不能新增或编辑通知",
    },
    {
      path: "miniprogram/pages/plan-edit/plan-edit.js",
      domain: "plan",
      childToast: "孩子账号不能新增或编辑计划",
    },
  ];

  for (const item of fixtures) {
    for (const state of [
      { name: "child", latestSession: { user: { role: "child", familyId: "family-1" }, family: { currentSemester: "2026下", educationStage: "junior_high" } } },
      { name: "null", latestSession: null },
      { name: "rejection", latestSession: rejection },
    ]) {
      let latestSession = {
        user: { role: "creator", familyId: "family-1" },
        family: { currentSemester: "2026下", educationStage: "junior_high" },
      };
      const fixture = loadPage(item.path, {
        requireFamily: async () => {
          if (latestSession instanceof Error) throw latestSession;
          return latestSession;
        },
      });

      await fixture.page.remove();
      assert.equal(fixture.showModalCalls.length, 1, `${item.path}: ${state.name}`);
      latestSession = state.latestSession;
      await assert.doesNotReject(fixture.showModalCalls[0].success({ confirm: true }), `${item.path}: ${state.name}`);
      assert.equal(fixture.callFunctionCalls.filter((args) => args[0] === item.domain && args[1] === "remove").length, 0, `${item.path}: ${state.name}`);
      assert.equal(fixture.navigateBackCalls.length, 0, `${item.path}: ${state.name}`);
      if (state.name === "child") {
        assert.equal(fixture.toastCalls.length, 1, `${item.path}: ${state.name}`);
        assert.equal(fixture.toastCalls[0].title, item.childToast, `${item.path}: ${state.name}`);
        assert.equal(fixture.toastCalls[0].icon, "none", `${item.path}: ${state.name}`);
        assert.equal(fixture.showErrorCalls.length, 0, `${item.path}: ${state.name} 不应显示错误`);
      }
      if (state.name === "null") {
        assert.equal(fixture.toastCalls.length, 0, `${item.path}: ${state.name} 不应显示拒绝提示`);
        assert.equal(fixture.showErrorCalls.length, 0, `${item.path}: ${state.name} 不应显示错误`);
      }
      if (state.name === "rejection") {
        assert.equal(fixture.toastCalls.length, 0, `${item.path}: ${state.name} 不应显示拒绝提示`);
        assert.deepEqual(fixture.showErrorCalls, [[rejection, "身份校验失败，请稍后重试"]], `${item.path}: ${state.name}`);
      }
    }
  }
});
