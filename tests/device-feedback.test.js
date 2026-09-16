const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function loadTabBar(route, switchTab) {
  let config;
  let currentRoute = route;
  vm.runInNewContext(read("miniprogram/custom-tab-bar/index.js"), {
    Component(value) { config = value; },
    require(request) { assert.equal(request, "../utils/navigation"); return require("../miniprogram/utils/navigation"); },
    getCurrentPages() { return [{ route: currentRoute }]; },
    wx: { switchTab, showToast() {} }, console: { error() {} },
  });
  const component = { data: JSON.parse(JSON.stringify(config.data)), setData(values) { Object.assign(this.data, values); } };
  for (const [name, fn] of Object.entries(config.methods)) component[name] = fn.bind(component);
  return { component, config, setRoute(value) { currentRoute = value; } };
}

test("自定义底栏在每次页面显示时同步路由，切换失败不伪造选中态", () => {
  let request;
  let count = 0;
  const fixture = loadTabBar("pages/homework-list/homework-list", (options) => { request = options; count += 1; });
  fixture.config.pageLifetimes.show.call(fixture.component);
  assert.equal(fixture.component.data.selected, 1);
  fixture.component.switchTab({ currentTarget: { dataset: { index: 2 } } });
  fixture.component.switchTab({ currentTarget: { dataset: { index: 3 } } });
  assert.equal(count, 1);
  assert.equal(request.url, "/pages/notice-list/notice-list");
  request.fail({ errCode: 1 }); request.complete();
  assert.equal(fixture.component.data.selected, 1);
  assert.equal(fixture.component.data.switching, false);
  fixture.setRoute("pages/settings/settings");
  fixture.config.pageLifetimes.show.call(fixture.component);
  assert.equal(fixture.component.data.selected, 4);
  fixture.component.switchTab({ currentTarget: { dataset: { index: 4 } } });
  fixture.component.switchTab({ currentTarget: { dataset: { index: 99 } } });
  assert.equal(count, 1);
});

test("底栏使用放大的自定义图文并为五页和撤销浮层预留空间", () => {
  assert.equal(JSON.parse(read("miniprogram/app.json")).tabBar.custom, true);
  assert.deepEqual(require("../miniprogram/utils/navigation").MAIN_TABS, JSON.parse(read("miniprogram/app.json")).tabBar.list);
  const style = read("miniprogram/custom-tab-bar/index.wxss");
  assert.match(style, /font-size: 14px/);
  assert.match(style, /width: 36px/);
  assert.match(style, /safe-area-inset-bottom/);
  for (const name of ["home", "homework-list", "notice-list", "habit-list", "settings"]) {
    assert.match(read(`miniprogram/pages/${name}/${name}.wxml`), /class="page tab-page/);
  }
  assert.match(read("miniprogram/app.wxss"), /\.tab-page \.completion-feedback/);
});

test("更多操作使用三个小圆点而非大号文字省略号", () => {
  for (const name of ["homework-list", "notice-list"]) {
    const template = read(`miniprogram/pages/${name}/${name}.wxml`);
    assert.match(template, /more-dots/);
    assert.doesNotMatch(template, />···<\/button>/);
  }
  assert.match(read("miniprogram/app.wxss"), /\.more-dot[^}]*width: 4px/);
});

test("科目删除仅位于当前修改面板且列表提供相邻排序", () => {
  const template = read("miniprogram/pages/subject-settings/subject-settings.wxml");
  const list = template.split("edit-card")[0];
  assert.doesNotMatch(list, /bindtap="remove"/);
  assert.match(list, /bindtap="moveSubject"/);
  assert.match(template, /editingCanRemove/);
});

test("课程表明确支持独立课程名称且保存说明区分覆盖规则", () => {
  const template = read("miniprogram/pages/timetable-import/timetable-import.wxml");
  assert.match(template, /保存选中课程/);
  assert.match(template, /自习/);
  assert.match(template, /同一星期/);
  assert.doesNotMatch(template, />合并选中课程</);
  const { createEditableTimetableDrafts } = require("../miniprogram/utils/timetable");
  const drafts = createEditableTimetableDrafts(["自修", "自习", "班会", "体级"].map((courseName, index) => ({ dayOfWeek: 1, period: index + 1, courseName, uncertainFields: [] })), ["语文"], [], "a".repeat(32));
  assert.deepEqual(drafts.map((item) => item.courseName), ["自修", "自习", "班会", "体级"]);
  assert.ok(drafts.every((item) => item.customCourse && !item.courseNameUncertain));
});
