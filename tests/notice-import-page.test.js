const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

function applyData(target, updates) {
  for (const [key, value] of Object.entries(updates)) {
    const matched = /^([^.[]+)\[(\d+)\]\.([^.]+)$/.exec(key);
    if (matched) {
      const [, collection, index, field] = matched;
      target[collection][Number(index)][field] = value;
    } else {
      target[key] = value;
    }
  }
}

function createFixture() {
  const pagePath = path.resolve(__dirname, "../miniprogram/pages/notice-import/notice-import.js");
  const requireLocal = createRequire(pagePath);
  const calls = [];
  const navigation = [];
  let pageConfig;
  const wx = {
    showModal(options) { options.success({ confirm: true, cancel: false }); },
    showToast() {},
    switchTab(options) { navigation.push(options.url); },
    enableAlertBeforeUnload() {},
    disableAlertBeforeUnload() {},
  };
  vm.runInNewContext(fs.readFileSync(pagePath, "utf8"), {
    Page(config) { pageConfig = config; },
    console: { error() {} },
    wx,
    require(request) {
      if (request === "../../utils/api") return {
        async callFunction(name, action, data) { calls.push({ name, action, data }); return { id: `notice-${calls.length}` }; },
        showError(error) { throw error; },
      };
      if (request === "../../utils/session") return { async requireFamily() { return { user: { role: "creator" }, family: { currentSemester: "2026下" } }; } };
      if (request === "../../utils/permissions") return { canPerform() { return true; } };
      if (request === "../../utils/ai-import") return { validateSelectedFiles() { return []; }, uploadFileWithCredential() {} };
      if (request === "../../utils/share") return { createShareAppMessage() {}, createShareTimelineMessage() {} };
      return requireLocal(request);
    },
  }, { filename: pagePath });
  const page = {
    data: structuredClone(pageConfig.data),
    currentUser: { role: "creator" },
    pageDestroyed: false,
    setData(updates) { applyData(this.data, updates); },
  };
  for (const [name, method] of Object.entries(pageConfig)) {
    if (typeof method === "function") page[name] = method.bind(page);
  }
  return { page, calls, navigation };
}

test("通知导入可以一次保存当前模式下全部未保存草稿", async () => {
  const fixture = createFixture();
  fixture.page.data.drafts = [
    { requestId: "01010101010101010101010101010101_0", semester: "2026下", title: "通知一", source: "班主任", category: "other", content: "内容一", saved: false },
    { requestId: "01010101010101010101010101010101_1", semester: "2026下", title: "通知二", source: "年级组", category: "activity", content: "内容二", saved: false },
  ];
  fixture.page.data.separateDrafts = structuredClone(fixture.page.data.drafts);
  fixture.page.data.draftMode = "separate";

  await fixture.page.saveAllDrafts();

  assert.deepEqual(fixture.calls.map(({ name, action }) => [name, action]), [["notice", "create"], ["notice", "create"]]);
  assert.ok(fixture.page.data.drafts.every((draft) => draft.saved));
  assert.deepEqual(fixture.navigation, ["/pages/notice-list/notice-list"]);
});

test("通知导入页提供合并选择和批量保存操作", () => {
  const template = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/notice-import/notice-import.wxml"), "utf8");
  assert.match(template, /通知保存方式/);
  assert.match(template, /整合为一条/);
  assert.match(template, /保留多条/);
  assert.match(template, /bindtap="saveAllDrafts"/);
});
