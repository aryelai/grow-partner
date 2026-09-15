const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { getBeijingDate } = require("../miniprogram/utils/date");

function loadPage(pageName, item = {}) {
  const sourcePath = path.resolve(__dirname, `../miniprogram/pages/${pageName}/${pageName}.js`);
  const requireFromPage = createRequire(sourcePath);
  const calls = [];
  const toasts = [];
  let configuration;
  const session = {
    user: { role: "creator", familyId: "family-id" },
    family: { educationStage: "junior_high", currentSemester: "2026下" },
  };
  const context = vm.createContext({
    Page(value) { configuration = value; }, Date, setTimeout, clearTimeout,
    console: { error() {} },
    wx: { showToast(value) { toasts.push(value); }, navigateBack() {} },
    require(request) {
      if (request === "../../utils/api") return {
        async callFunction(name, action, payload) {
          calls.push({ name, action, payload });
          if (name === "settings") return { subjects: ["语文", "数学"] };
          if (action === "get") return structuredClone(item);
          if (action === "list") return { items: [structuredClone(item)], hasMore: false };
          return { id: "saved-id" };
        },
        showError(error) { toasts.push({ title: error.message }); },
      };
      if (request === "../../utils/session") return { requireFamily: async () => session };
      return requireFromPage(request);
    },
  });
  vm.runInContext(fs.readFileSync(sourcePath, "utf8"), context, { filename: sourcePath });
  const page = {
    data: structuredClone(configuration.data),
    currentUser: session.user,
    setData(values) {
      for (const [key, value] of Object.entries(values)) {
        const segments = key.split(".");
        const target = segments.slice(0, -1).reduce((result, segment) => result[segment], this.data);
        target[segments.at(-1)] = value;
      }
    },
  };
  for (const [key, value] of Object.entries(configuration)) {
    if (typeof value === "function") page[key] = value.bind(page);
  }
  return { page, calls, toasts };
}

test("手动新增默认北京时间今天且修改日期独立保存", async () => {
  const { page, calls } = loadPage("homework-edit");
  await page.onLoad({});
  assert.equal(page.data.form.homeworkDate, getBeijingDate());
  page.onHomeworkDate({ detail: { value: "2026-09-14" } });
  page.onInput({ currentTarget: { dataset: { field: "title" } }, detail: { value: "原文".repeat(50) } });
  await page.save();
  const saved = calls.find((call) => call.name === "homework" && call.action === "create");
  assert.equal(saved.payload.homeworkDate, "2026-09-14");
  assert.equal(saved.payload.title, "原文".repeat(50));
  assert.equal(saved.payload.content, "");
  assert.equal(saved.payload.deadline, null);
});

test("编辑历史作业不补猜日期且非法日期或超长主题不提交", async () => {
  const { page, calls, toasts } = loadPage("homework-edit", { subject: "数学", title: "历史作业" });
  await page.onLoad({ id: "legacy" });
  assert.equal(page.data.form.homeworkDate, "");
  await page.save();
  assert.match(toasts.at(-1).title, /作业日期/);
  page.onHomeworkDate({ detail: { value: "2026-02-29" } });
  await page.save();
  page.onHomeworkDate({ detail: { value: "2026-09-14" } });
  page.onInput({ currentTarget: { dataset: { field: "title" } }, detail: { value: "题".repeat(501) } });
  await page.save();
  assert.match(toasts.at(-1).title, /500/);
  assert.equal(calls.filter((call) => call.action === "update").length, 0);
  assert.equal(page.data.submitting, false);
});

test("已保存日期加载后可修改且详细要求保持独立", async () => {
  const { page, calls } = loadPage("homework-edit", { semester: "2026下", subject: "数学", title: "卷《有理数》", homeworkDate: "2026-09-14", content: "家长检查" });
  await page.onLoad({ id: "homework-id" });
  assert.equal(page.data.homeworkDateText, "2026-09-14 周一");
  page.onHomeworkDate({ detail: { value: "2026-09-15" } });
  await page.save();
  const saved = calls.find((call) => call.action === "update");
  assert.equal(saved.payload.homeworkDate, "2026-09-15");
  assert.equal(saved.payload.content, "家长检查");
});

test("列表与详情正确展示作业日期并保留长主题全文", async () => {
  const item = { _id: "homework-id", subject: "政治", homeworkDate: "2026-09-14", title: "时政分享（带U盘1号）".repeat(10), content: "" };
  const list = loadPage("homework-list", item);
  await list.page.load(true);
  assert.equal(list.page.data.items[0].homeworkDateText, "2026-09-14 周一");
  assert.equal(list.page.data.items[0].title, item.title);
  const detail = loadPage("homework-detail", item);
  detail.page.setData({ id: item._id });
  await detail.page.load();
  assert.equal(detail.page.data.item.homeworkDateText, "2026-09-14 周一");
  assert.equal(detail.page.data.item.title, item.title);
  assert.equal(detail.page.data.item.content, "");
  const legacy = loadPage("homework-list", { ...item, homeworkDate: undefined });
  await legacy.page.load(true);
  assert.equal(legacy.page.data.items[0].homeworkDateMissing, true);
});

test("作业页面使用多行主题和醒目日期标签且空详细要求显示无", () => {
  for (const pageName of ["homework-edit", "homework-import"]) {
    const template = fs.readFileSync(path.resolve(__dirname, `../miniprogram/pages/${pageName}/${pageName}.wxml`), "utf8");
    assert.match(template, /<textarea[^>]*homework-theme-input[^>]*auto-height/);
    assert.match(template, /bindchange="onHomeworkDate"/);
    assert.match(template, /详细要求/);
    assert.doesNotMatch(template, /详细内容/);
  }
  for (const pageName of ["homework-list", "homework-detail"]) {
    const template = fs.readFileSync(path.resolve(__dirname, `../miniprogram/pages/${pageName}/${pageName}.wxml`), "utf8");
    assert.match(template, /homework-subject-label/);
    assert.match(template, /homework-date-label/);
    assert.match(template, /content \|\| '无'/);
    const style = fs.readFileSync(path.resolve(__dirname, `../miniprogram/pages/${pageName}/${pageName}.wxss`), "utf8");
    assert.match(style, /white-space: pre-wrap; word-break: break-all/);
  }
});

test("作业列表底部操作区留有安全区且不以悬浮按钮遮挡日期标签", () => {
  const template = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/homework-list/homework-list.wxml"), "utf8");
  const style = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/homework-list/homework-list.wxss"), "utf8");
  assert.match(template, /class="homework-actions"/);
  assert.doesNotMatch(template, /class="fab"/);
  assert.match(style, /\.homework-page\.has-actions \{ padding-bottom: calc\(160rpx \+ env\(safe-area-inset-bottom\)\)/);
  assert.doesNotMatch(style, /position: sticky/);
});
