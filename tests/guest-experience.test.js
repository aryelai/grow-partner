const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const projectRoot = path.resolve(__dirname, "..");
const miniprogramRoot = path.join(projectRoot, "miniprogram");

function loadPage(relativePath, session = null) {
  const sourcePath = path.join(projectRoot, relativePath);
  const source = fs.readFileSync(sourcePath, "utf8");
  const requireFromPage = createRequire(sourcePath);
  const callFunctionCalls = [];
  const modalCalls = [];
  const navigations = [];
  let pageConfig;
  const context = vm.createContext({
    Page(config) { pageConfig = config; },
    getApp() { return { globalData: {} }; },
    setTimeout,
    clearTimeout,
    console,
    wx: {
      navigateTo(options) { navigations.push(options); },
      switchTab(options) { navigations.push(options); },
      showModal(options) { modalCalls.push(options); },
      showToast() {},
      stopPullDownRefresh() {},
    },
    require(request) {
      if (request === "../../utils/session") {
        return { requireFamily: async () => session };
      }
      if (request === "../../utils/api") {
        return {
          async callFunction(...args) {
            callFunctionCalls.push(args);
            return { items: [], hasMore: false };
          },
          showError() {},
        };
      }
      return requireFromPage(request);
    },
  });
  vm.runInContext(source, context, { filename: sourcePath });
  const page = {
    data: JSON.parse(JSON.stringify(pageConfig.data)),
    setData(values) {
      for (const [key, value] of Object.entries(values)) {
        const matched = /^(\w+)\[(\d+)\]\.(\w+)$/.exec(key);
        if (matched) {
          this.data[matched[1]][Number(matched[2])][matched[3]] = value;
        } else {
          this.data[key] = value;
        }
      }
    },
  };
  for (const [name, value] of Object.entries(pageConfig)) {
    if (typeof value === "function") page[name] = value.bind(page);
  }
  return { page, callFunctionCalls, modalCalls, navigations };
}

test("默认首屏允许未注册用户浏览作业演示", () => {
  const appConfig = JSON.parse(fs.readFileSync(path.join(miniprogramRoot, "app.json"), "utf8"));
  assert.equal(appConfig.pages[0], "pages/homework-list/homework-list");
});

test("运行时代码不包含手机号、微信头像或微信昵称授权入口", () => {
  const runtimeFiles = [];
  const collect = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(fullPath);
      else if (/\.(js|wxml)$/.test(entry.name)) runtimeFiles.push(fullPath);
    }
  };
  collect(miniprogramRoot);
  const source = runtimeFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(source, /getPhoneNumber|open-type=["']chooseAvatar["']|type=["']nickname["']/);
});

test("四个核心列表在无家庭会话时只展示本地演示数据", async () => {
  const pages = [
    "miniprogram/pages/homework-list/homework-list.js",
    "miniprogram/pages/notice-list/notice-list.js",
    "miniprogram/pages/habit-list/habit-list.js",
    "miniprogram/pages/plan-list/plan-list.js",
  ];
  for (const relativePath of pages) {
    const fixture = loadPage(relativePath);
    await fixture.page.onShow();
    assert.equal(fixture.page.data.guestMode, true, relativePath);
    assert.ok(fixture.page.data.items.length > 0, relativePath);
    assert.equal(fixture.page.data.loading, false, relativePath);
    assert.equal(fixture.callFunctionCalls.length, 0, relativePath);
  }
});

test("游客浏览筛选和计划勾选不会调用业务云函数", async () => {
  const homework = loadPage("miniprogram/pages/homework-list/homework-list.js");
  await homework.page.onShow();
  homework.page.selectStatus({ currentTarget: { dataset: { value: "completed" } } });
  assert.equal(homework.callFunctionCalls.length, 0);

  const notice = loadPage("miniprogram/pages/notice-list/notice-list.js");
  await notice.page.onShow();
  notice.page.selectCategory({ currentTarget: { dataset: { value: "exam" } } });
  assert.equal(notice.callFunctionCalls.length, 0);

  const habit = loadPage("miniprogram/pages/habit-list/habit-list.js");
  await habit.page.onShow();
  habit.page.selectCategory({ currentTarget: { dataset: { value: "study" } } });
  assert.equal(habit.callFunctionCalls.length, 0);

  const plan = loadPage("miniprogram/pages/plan-list/plan-list.js");
  await plan.page.onShow();
  const firstPlan = plan.page.data.items[0];
  await plan.page.toggleItem({
    currentTarget: { dataset: { id: firstPlan._id, index: 0 } },
    detail: { value: !firstPlan.items[0].isDone },
  });
  assert.equal(plan.callFunctionCalls.length, 0);
});

test("设置页对游客展示说明且不读取家庭设置", async () => {
  const fixture = loadPage("miniprogram/pages/settings/settings.js");
  await fixture.page.onShow();
  assert.equal(fixture.page.data.guestMode, true);
  assert.equal(fixture.page.data.family, null);
  assert.equal(fixture.callFunctionCalls.length, 0);
});

test("登录页提供可用的继续体验出口", () => {
  const script = fs.readFileSync(path.join(miniprogramRoot, "pages/login/login.js"), "utf8");
  const template = fs.readFileSync(path.join(miniprogramRoot, "pages/login/login.wxml"), "utf8");
  assert.match(script, /continueExperience\s*\(/);
  assert.match(template, /bindtap="continueExperience"/);
  assert.match(template, /家庭称呼/);
});

test("游客演示数据可按业务条件过滤且不包含云资源", () => {
  const {
    createGuestHomeworkItems,
    createGuestNoticeItems,
    createGuestHabitItems,
    createGuestPlanState,
  } = require("../miniprogram/utils/guest-experience");
  assert.ok(createGuestHomeworkItems({ subject: "数学", status: "pending", keyword: "练习" }).length > 0);
  assert.ok(createGuestNoticeItems({ category: "exam", keyword: "考试" }).length > 0);
  assert.ok(createGuestHabitItems("study").length > 0);
  assert.ok(createGuestPlanState("daily", "2026-09-14").items.length > 0);
  const serialized = JSON.stringify({
    homework: createGuestHomeworkItems({ subject: "全部", status: "all", keyword: "" }),
    notices: createGuestNoticeItems({ category: "all", keyword: "" }),
    habits: createGuestHabitItems("behavior"),
    plans: createGuestPlanState("daily", "2026-09-14").items,
  });
  assert.doesNotMatch(serialized, /cloud:\/\/|openid|familyId|inviteCode/i);
});
