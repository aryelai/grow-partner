const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

function setByPath(target, key, value) {
  const segments = key.match(/[^.[\]]+/g);
  let current = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (current[segment] === undefined) current[segment] = /^\d+$/.test(segments[index + 1]) ? [] : {};
    current = current[segment];
  }
  current[segments.at(-1)] = value;
}

function loadPage(pageName, overrides = {}) {
  const sourcePath = path.resolve(__dirname, `../miniprogram/pages/${pageName}/${pageName}.js`);
  const source = fs.readFileSync(sourcePath, "utf8");
  const requireFromPage = createRequire(sourcePath);
  let pageConfig;
  const calls = [];
  const navigations = [];
  const backs = [];
  const modals = [];
  const toasts = [];
  const callFunction = overrides.callFunction || (async (name, action) => {
    calls.push({ name, action });
    if (name === "timetable" && action === "get") return {
      semester: "2026下",
      version: 1,
      entries: [{ dayOfWeek: 1, period: 1, courseName: "语文", teacher: "李老师", location: "101", startTime: "", endTime: "" }],
    };
    if (name === "ai") return { enabled: true, canImport: true, blockedReason: "" };
    if (name === "settings") return { subjects: ["语文", "数学"] };
    throw new Error(`测试未实现请求：${name}.${action}`);
  });
  const wx = {
    navigateTo(options) { navigations.push(options); },
    navigateBack() { backs.push(true); },
    showModal(options) { modals.push(options); },
    showToast(options) { toasts.push(options); },
    stopPullDownRefresh() {},
  };
  const context = vm.createContext({
    Page(config) { pageConfig = config; },
    wx,
    console: { error() {} },
    Date,
    Promise,
    module: { exports: {} },
    exports: {},
    require(request) {
      if (request === "../../utils/api") return { callFunction, showError(error) { toasts.push({ title: error.message }); } };
      if (request === "../../utils/session") return { requireFamily: overrides.requireFamily || (async () => null) };
      return requireFromPage(request);
    },
  });
  vm.runInContext(source, context, { filename: sourcePath });
  const page = {
    data: JSON.parse(JSON.stringify(pageConfig.data)),
    setData(values) { for (const [key, value] of Object.entries(values)) setByPath(this.data, key, value); },
  };
  for (const [name, value] of Object.entries(pageConfig)) if (typeof value === "function") page[name] = value.bind(page);
  return { page, calls, navigations, backs, modals, toasts };
}

test("课程表未登录时只展示本地示例且不调用业务云函数", async () => {
  const fixture = loadPage("timetable");
  await fixture.page.onShow();
  assert.equal(fixture.page.data.guestMode, true);
  assert.equal(fixture.page.data.slots.length, 12);
  assert.equal(fixture.page.data.slots[0].entry.courseName, "语文");
  assert.equal(fixture.calls.length, 0);
});

test("孩子可以读取课程表但不能进入编辑或 AI 导入", async () => {
  const fixture = loadPage("timetable", {
    requireFamily: async () => ({
      user: { role: "child", familyId: "family-1" },
      family: { currentSemester: "2026下" },
    }),
  });
  await fixture.page.onShow();
  assert.equal(fixture.page.data.canManage, false);
  assert.equal(fixture.page.data.canUseImport, false);
  fixture.page.openSlot({ currentTarget: { dataset: { period: 1 } } });
  fixture.page.importTimetable();
  assert.equal(fixture.navigations.length, 0);
});

test("成人可编辑课程格并在 AI 可用时进入课程表导入页", async () => {
  const fixture = loadPage("timetable", {
    requireFamily: async () => ({
      user: { role: "member", familyId: "family-1" },
      family: { currentSemester: "2026下" },
    }),
  });
  await fixture.page.onShow();
  fixture.page.openSlot({ currentTarget: { dataset: { period: 1 } } });
  fixture.page.importTimetable();
  assert.deepEqual(fixture.navigations.map((item) => item.url), [
    `/pages/timetable-edit/timetable-edit?dayOfWeek=${fixture.page.data.selectedDay}&period=1`,
    "/pages/timetable-import/timetable-import",
  ]);
});

test("课程表云函数暂不可用时仍展示十二节空状态", async () => {
  const fixture = loadPage("timetable", {
    requireFamily: async () => ({
      user: { role: "member", familyId: "family-1" },
      family: { currentSemester: "2026下" },
    }),
    callFunction: async (name) => {
      if (name === "ai") return { enabled: true, canImport: true, blockedReason: "" };
      throw new Error("云函数暂不可用");
    },
  });

  await fixture.page.onShow();
  assert.equal(fixture.page.data.loading, false);
  assert.equal(fixture.page.data.slots.length, 12);
  assert.equal(fixture.page.data.slots.every((slot) => slot.hasEntry === false), true);
});

test("孩子直接打开课程编辑页会被拒绝且不读取课程数据", async () => {
  const fixture = loadPage("timetable-edit", {
    requireFamily: async () => ({
      user: { role: "child", familyId: "family-1" },
      family: { currentSemester: "2026下", educationStage: "junior_high" },
    }),
  });
  await fixture.page.onLoad({ dayOfWeek: "1", period: "1" });
  assert.equal(fixture.backs.length, 1);
  assert.equal(fixture.calls.length, 0);
});
