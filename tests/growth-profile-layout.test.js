const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const projectRoot = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(projectRoot, file), "utf8");

test("公共图标样式使用微信打包器可识别的显式相对导入", () => {
  const stylesheet = read("miniprogram/app.wxss");
  assert.match(stylesheet, /@import "\.\/styles\/ui-icons\.wxss";/);
  const icons = read("miniprogram/styles/ui-icons.wxss");
  for (const name of ["leaf", "plan", "calendar", "subject", "family", "bell", "setting", "shield"]) {
    assert.match(icons, new RegExp(`\\.ui-icon-${name}\\b`));
  }
});

function loadPage(name, request) {
  const sourcePath = path.join(projectRoot, `miniprogram/pages/${name}/${name}.js`);
  const pageRequire = createRequire(sourcePath);
  const calls = [];
  const navigations = [];
  const application = { globalData: {} };
  let configuration;
  vm.runInNewContext(read(`miniprogram/pages/${name}/${name}.js`), {
    Page(value) { configuration = value; },
    getApp() { return application; },
    Date, console: { error() {} },
    wx: { showToast() {}, showModal() {}, navigateTo(value) { navigations.push(value); }, switchTab(value) { navigations.push(value); } },
    require(dependency) {
      if (dependency === "../../utils/api") return { async callFunction(...args) { calls.push(args); return request(...args); }, showError() {} };
      if (dependency === "../../utils/session") return { requireFamily: async () => ({ user: { role: "creator", familyId: "family" }, family: { currentSemester: "2026下" } }) };
      return pageRequire(dependency);
    },
  }, { filename: sourcePath });
  const page = { data: structuredClone(configuration.data), setData(values, callback) {
    for (const [key, value] of Object.entries(values)) {
      const parts = key.split(".");
      const target = parts.slice(0, -1).reduce((current, part) => current[part], this.data);
      target[parts.at(-1)] = value;
    }
    if (callback) callback();
  } };
  for (const [key, value] of Object.entries(configuration)) if (typeof value === "function") page[key] = value.bind(page);
  return { page, calls, navigations, application };
}

test("成长页采用确认原型的摘要切换卡、坚持概览和紧凑习惯行", () => {
  const template = read("miniprogram/pages/habit-list/habit-list.wxml");
  for (const name of ["list-page-head", "growth-switch", "growth-switch-meta", "habit-hero", "habit-mark", "habit-copy", "checkin-button"]) assert.match(template, new RegExp(name));
  assert.match(template, /今日习惯/);
  assert.match(template, /新增习惯/);
  assert.doesNotMatch(template, /progress-row|habit-footer|养成每日小习惯/);
  assert.match(template, /bindsummarychange="onPlanSummary"/);
});

test("习惯分类只筛选列表而不改变全体习惯的今日摘要", async () => {
  const fixture = loadPage("habit-list", async () => ({ items: [
    { _id: "reading", category: "study", name: "阅读", streak: 5, completedDays: 9, targetDays: 21 },
    { _id: "sleep", category: "life", name: "早睡", streak: 0, completedDays: 3, targetDays: 21 },
  ] }));
  await fixture.page.load();
  assert.equal(fixture.page.data.habitTotal, 2);
  assert.equal(fixture.page.data.habitDone, 1);
  assert.equal(fixture.page.data.longestStreak, 5);
  fixture.page.selectCategory({ currentTarget: { dataset: { value: "life" } } });
  assert.equal(fixture.page.data.items.length, 1);
  assert.equal(fixture.page.data.items[0]._id, "sleep");
  assert.equal(fixture.page.data.habitTotal, 2);
  assert.equal(fixture.page.data.habitDone, 1);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0][2].category, "all");
});

test("成长计划摘要只接受当天日计划且拒绝非法数量", () => {
  const fixture = loadPage("habit-list", async () => ({ items: [] }));
  fixture.page.onPlanSummary({ detail: { isToday: true, total: 5, done: 3 } });
  assert.equal(fixture.page.data.planSummary, "今日 3/5 已完成");
  fixture.page.onPlanSummary({ detail: { isToday: false, total: 20, done: 19 } });
  fixture.page.onPlanSummary({ detail: { isToday: true, total: 3, done: 4 } });
  assert.equal(fixture.page.data.planSummary, "今日 3/5 已完成");
});

test("我的默认仅显示服务入口且设置面板互斥展开", () => {
  const fixture = loadPage("settings", async () => ({}));
  assert.equal(fixture.page.data.expandedSection, "");
  fixture.page.toggleSection({ currentTarget: { dataset: { section: "reminder" } } });
  assert.equal(fixture.page.data.expandedSection, "reminder");
  fixture.page.toggleSection({ currentTarget: { dataset: { section: "ai" } } });
  assert.equal(fixture.page.data.expandedSection, "ai");
  fixture.page.toggleSection({ currentTarget: { dataset: { section: "invalid" } } });
  assert.equal(fixture.page.data.expandedSection, "ai");
  fixture.page.toggleSection({ currentTarget: { dataset: { section: "ai" } } });
  assert.equal(fixture.page.data.expandedSection, "");
  fixture.page.setData({ saving: true });
  fixture.page.toggleSection({ currentTarget: { dataset: { section: "general" } } });
  assert.equal(fixture.page.data.expandedSection, "");
});

test("我的保留家庭邀请码和当前学期并采用原型服务列表", () => {
  const template = read("miniprogram/pages/settings/settings.wxml");
  for (const name of ["list-page-head", "role-chip", "family-row", "feature-grid", "settings-group", "settings-item"]) assert.match(template, new RegExp(name));
  for (const title of ["家庭邀请码", "当前学期", "学习管理", "服务与偏好", "通知与提醒", "AI 能力", "通用设置", "隐私与关于"]) assert.match(template, new RegExp(title));
  assert.match(template, /bindtap="copyInviteCode"/);
  assert.match(template, /bindtap="changeSemester"/);
  assert.match(template, /wx:if="\{\{expandedSection === 'reminder'\}\}"/);
  assert.match(template, /wx:if="\{\{expandedSection === 'ai'\}\}"/);
  assert.match(template, /bindtap="openPrivacyContract"/);
});

test("我的全部计划入口切换到成长内的计划而非旧独立页", () => {
  const fixture = loadPage("settings", async () => ({}));
  fixture.page.goPlans();
  assert.equal(fixture.application.globalData.growthEntry.view, "plan");
  assert.equal(fixture.navigations[0].url, "/pages/habit-list/habit-list");
});

test("成长计划行采用可撤销勾选按钮而不使用大型开关", () => {
  const template = read("miniprogram/components/plan-panel/plan-panel.wxml");
  assert.match(template, /我的计划/);
  assert.match(template, /growth-plan-check/);
  assert.match(template, /bindtap="toggleTask"/);
  assert.doesNotMatch(template, /<switch/);
  assert.match(template, /toggleBusy \|\| loading \? 'disabled'/);
  assert.doesNotMatch(read("miniprogram/components/plan-panel/plan-panel.wxss"), /\[disabled\]/);
  const style = read("miniprogram/pages/habit-list/habit-list.wxss");
  assert.match(style, /\.checkin-button[^}]*min-height: var\(--touch-size\)/);
  assert.match(style, /\.growth-switch-button[^}]*min-height: 128rpx/);
});
