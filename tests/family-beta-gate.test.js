const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const projectRoot = path.resolve(__dirname, "..");
const validInviteCode = "ABCDEFGH";
const registrationDeniedMessage = "暂时无法完成注册，请检查家庭邀请码后重试";

function createLoginDatabase(options = {}) {
  const state = {
    users: options.users || [],
    families: options.families || [],
    limitCount: options.limitCount || 0,
    addedUser: null,
    updatedUser: null,
    limitDocumentId: "",
    limitData: null,
    familyLookups: 0,
  };
  const collection = (name) => {
    if (name === "users") {
      return {
        where(query) {
          return { limit() { return { async get() { return { data: state.users.filter((item) => item.openid === query.openid) }; } }; } };
        },
        async add({ data }) { state.addedUser = data; return { _id: "new-user-id" }; },
        doc() { return { async update({ data }) { state.updatedUser = data; } }; },
      };
    }
    if (name === "families") {
      return {
        where(query) {
          state.familyLookups += 1;
          return { limit() { return { async get() { return { data: state.families.filter((item) => item.inviteCode === query.inviteCode) }; } }; } };
        },
      };
    }
    if (name === "family_search_limits") {
      return {
        doc(documentId) {
          state.limitDocumentId = documentId;
          return {
            async get() {
              if (!state.limitCount) throw new Error("document does not exist");
              return { data: { count: state.limitCount } };
            },
            async set({ data }) { state.limitData = data; state.limitCount = data.count; },
          };
        },
      };
    }
    if (name === "family_join_requests") {
      return { where() { return { limit() { return { async get() { return { data: [] }; } }; } }; } };
    }
    throw new Error(`测试未实现集合：${name}`);
  };
  return {
    state,
    database: {
      collection,
      async runTransaction(callback) { return callback({ collection }); },
    },
  };
}

function loadLoginFunction(database, registrationMode) {
  const sourcePath = path.join(projectRoot, "cloudfunctions/login/index.js");
  const source = fs.readFileSync(sourcePath, "utf8");
  const requireFromLogin = createRequire(sourcePath);
  const cloud = {
    DYNAMIC_CURRENT_ENV: "test",
    init() {},
    database() { return database; },
    getWXContext() { return { OPENID: "test-openid" }; },
  };
  const moduleValue = { exports: {} };
  const context = vm.createContext({
    console: { error() {} },
    Date,
    Error,
    process: { env: { REGISTRATION_MODE: registrationMode } },
    module: moduleValue,
    exports: moduleValue.exports,
    require(request) {
      if (request === "wx-server-sdk") return cloud;
      if (request === "crypto") return require("node:crypto");
      return requireFromLogin(request);
    },
  });
  vm.runInContext(source, context, { filename: sourcePath });
  return moduleValue.exports.main;
}

function loadFamilyFunction(registrationMode) {
  const sourcePath = path.join(projectRoot, "cloudfunctions/family/index.js");
  const source = fs.readFileSync(sourcePath, "utf8");
  const requireFromFamily = createRequire(sourcePath);
  const cloud = {
    DYNAMIC_CURRENT_ENV: "test",
    init() {},
    database() { return { collection() { throw new Error("受限模式不应访问数据库"); } }; },
    getWXContext() { return { OPENID: "test-openid" }; },
  };
  const moduleValue = { exports: {} };
  const context = vm.createContext({
    console: { error() {} },
    Date,
    Error,
    process: { env: { REGISTRATION_MODE: registrationMode } },
    module: moduleValue,
    exports: moduleValue.exports,
    require(request) {
      if (request === "wx-server-sdk") return cloud;
      if (request === "crypto") return require("node:crypto");
      return requireFromFamily(request);
    },
  });
  vm.runInContext(source, context, { filename: sourcePath });
  return moduleValue.exports.main;
}

test("未注册用户只能看到公开的注册模式", async () => {
  for (const [configuredMode, expectedMode] of [["open", "open"], ["family_invite", "family_invite"], ["closed", "closed"], ["invalid", "closed"], [undefined, "closed"]]) {
    const { database } = createLoginDatabase();
    const result = await loadLoginFunction(database, configuredMode)({ action: "getProfile" });
    assert.equal(result.success, true);
    assert.equal(result.data.registered, false);
    assert.equal(result.data.registrationMode, expectedMode);
    assert.equal(Object.hasOwn(result.data, "familyId"), false);
    assert.equal(Object.hasOwn(result.data, "inviteCode"), false);
  }
});

test("家庭邀请码模式只允许持有现有有效邀请码的新用户注册", async () => {
  const { database, state } = createLoginDatabase({ families: [{ _id: "family-id", inviteCode: validInviteCode }] });
  const main = loadLoginFunction(database, "family_invite");

  const result = await main({ action: "register", nickname: "家庭成员", avatar: "", inviteCode: "abcd-efgh" });

  assert.equal(result.success, true);
  assert.equal(state.familyLookups, 1);
  assert.match(state.limitDocumentId, /^registration-invite-/);
  assert.equal(state.limitData.count, 1);
  assert.equal(state.addedUser.nickname, "家庭成员");
  assert.equal(Object.hasOwn(state.addedUser, "inviteCode"), false);
  assert.equal(Object.hasOwn(state.addedUser, "invitedFamilyId"), false);
});

test("开放模式注册无需邀请码且不查询家庭", async () => {
  const { database, state } = createLoginDatabase();
  const result = await loadLoginFunction(database, "open")({ action: "register", nickname: "公开用户", avatar: "" });

  assert.equal(result.success, true);
  assert.equal(state.addedUser.nickname, "公开用户");
  assert.equal(state.familyLookups, 0);
  assert.equal(state.limitDocumentId, "");
});

test("邀请码注册失败使用通用响应且达到二十次后不再查询家庭", async () => {
  for (const event of [
    { action: "register", nickname: "家庭成员", avatar: "" },
    { action: "register", nickname: "家庭成员", avatar: "", inviteCode: "BAD" },
    { action: "register", nickname: "家庭成员", avatar: "", inviteCode: validInviteCode },
  ]) {
    const { database, state } = createLoginDatabase({ limitCount: event.inviteCode === validInviteCode ? 20 : 0 });
    const result = await loadLoginFunction(database, "family_invite")(event);
    assert.equal(result.success, false);
    assert.equal(result.message, registrationDeniedMessage);
    assert.equal(state.addedUser, null);
    if (event.inviteCode === validInviteCode) assert.equal(state.familyLookups, 0);
  }
});

test("邀请码校验从第十九次递增到二十次并拒绝后续尝试", async () => {
  const { database, state } = createLoginDatabase({ limitCount: 19 });
  const main = loadLoginFunction(database, "family_invite");
  const event = { action: "register", nickname: "家庭成员", avatar: "", inviteCode: validInviteCode };

  const twentieth = await main(event);
  const twentyFirst = await main(event);
  const twentySecond = await main(event);

  assert.equal(twentieth.message, registrationDeniedMessage);
  assert.equal(twentyFirst.message, registrationDeniedMessage);
  assert.equal(twentySecond.message, registrationDeniedMessage);
  assert.equal(state.limitCount, 20);
  assert.equal(state.familyLookups, 1);
});

test("已有用户在关闭注册时仍可更新资料且不消耗邀请码次数", async () => {
  const existingUser = { _id: "user-id", openid: "test-openid", nickname: "旧昵称", avatar: "", familyId: "family-id", relation: "father", role: "creator" };
  const { database, state } = createLoginDatabase({ users: [existingUser], limitCount: 20 });
  const result = await loadLoginFunction(database, "closed")({ action: "register", nickname: "新昵称", avatar: "" });

  assert.equal(result.success, true);
  assert.equal(state.updatedUser.nickname, "新昵称");
  assert.equal(state.limitDocumentId, "");
  assert.equal(state.familyLookups, 0);
});

test("非开放模式禁止创建新家庭", async () => {
  for (const registrationMode of ["family_invite", "closed", "invalid", undefined]) {
    const result = await loadFamilyFunction(registrationMode)({ action: "create" });
    assert.equal(result.success, false);
    assert.equal(result.message, "当前版本暂不支持创建新家庭");
  }
});

function loadLoginPage(profileResponse) {
  const sourcePath = path.join(projectRoot, "miniprogram/pages/login/login.js");
  const source = fs.readFileSync(sourcePath, "utf8");
  const requireFromPage = createRequire(sourcePath);
  const calls = [];
  const navigations = [];
  const toasts = [];
  const errors = [];
  let pageConfig;
  const context = vm.createContext({
    Page(config) { pageConfig = config; },
    getApp() { return { globalData: {} }; },
    wx: {
      navigateTo(options) { navigations.push(options); },
      switchTab(options) { navigations.push(options); },
      showToast(options) { toasts.push(options); },
    },
    console,
    require(request) {
      if (request === "../../utils/api") {
        return {
          async callFunction(...args) {
            calls.push(args);
            if (args[1] !== "getProfile") return {};
            if (profileResponse instanceof Error) throw profileResponse;
            return profileResponse;
          },
          showError(...args) { errors.push(args); },
        };
      }
      return requireFromPage(request);
    },
  });
  vm.runInContext(source, context, { filename: sourcePath });
  const page = {
    data: JSON.parse(JSON.stringify(pageConfig.data)),
    setData(values) { Object.assign(this.data, values); },
  };
  for (const [name, value] of Object.entries(pageConfig)) {
    if (typeof value === "function") page[name] = value.bind(page);
  }
  return { page, calls, navigations, toasts, errors };
}

test("家庭邀请码模式的注册页提交规范化邀请码并隐藏创建家庭入口", async () => {
  const fixture = loadLoginPage({ registered: false, user: null, family: null, pendingJoinRequest: null, registrationMode: "family_invite" });
  await fixture.page.onLoad();
  fixture.page.onNicknameInput({ detail: { value: "家庭成员" } });
  fixture.page.onInviteCodeInput({ detail: { value: "abcd-efgh" } });
  await fixture.page.register();
  fixture.page.goCreateFamily();

  const registerCall = fixture.calls.find((item) => item[1] === "register");
  assert.equal(registerCall[2].inviteCode, validInviteCode);
  assert.equal(fixture.page.data.canCreateFamily, false);
  assert.equal(fixture.navigations.some((item) => item.url.includes("family-create")), false);
});

test("关闭注册时客户端不提交注册请求", async () => {
  const fixture = loadLoginPage({ registered: false, user: null, family: null, pendingJoinRequest: null, registrationMode: "closed" });
  await fixture.page.onLoad();
  fixture.page.onNicknameInput({ detail: { value: "家庭成员" } });
  await fixture.page.register();

  assert.equal(fixture.calls.some((item) => item[1] === "register"), false);
  assert.match(fixture.toasts.at(-1).title, /暂未开放/);
});

test("登录状态查询失败时显示可重试故障而不是注册关闭", async () => {
  const failure = new Error("network unavailable");
  const fixture = loadLoginPage(failure);

  await fixture.page.onLoad();
  assert.equal(fixture.page.data.loading, false);
  assert.equal(fixture.page.data.loadFailed, true);
  assert.equal(fixture.errors.length, 1);
  assert.equal(fixture.errors[0][1], "登录状态加载失败");

  await fixture.page.retryProfile();
  assert.equal(fixture.calls.filter((item) => item[1] === "getProfile").length, 2);
  assert.equal(fixture.page.data.loadFailed, true);
});

test("家庭内测版只为 AI 作业导入开放临时截图选择", () => {
  const pageFiles = [
    "miniprogram/pages/homework-edit/homework-edit.wxml",
    "miniprogram/pages/notice-edit/notice-edit.wxml",
    "miniprogram/pages/habit-detail/habit-detail.wxml",
  ];
  for (const relativePath of pageFiles) {
    const source = fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
    assert.match(source, /家庭内测期间暂不支持新增/);
    assert.doesNotMatch(source, /bindchooseavatar|bindtap="chooseMedia"|bindtap="chooseImages"|bindtap="choosePhoto"/);
  }

  const runtimeFiles = [
    "miniprogram/utils/api.js",
    "miniprogram/pages/login/login.js",
    "miniprogram/pages/homework-edit/homework-edit.js",
    "miniprogram/pages/notice-edit/notice-edit.js",
    "miniprogram/pages/habit-detail/habit-detail.js",
  ];
  for (const relativePath of runtimeFiles) {
    const source = fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
    assert.doesNotMatch(source, /wx\.cloud\.uploadFile|wx\.chooseMedia/);
  }

  const importSource = fs.readFileSync(path.join(projectRoot, "miniprogram/pages/homework-import/homework-import.js"), "utf8");
  assert.match(importSource, /wx\.chooseMedia/);
  assert.doesNotMatch(importSource, /wx\.cloud\.uploadFile/);
});
