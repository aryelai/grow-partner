const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadSubjectSettingsPage() {
  const sourcePath = path.join(__dirname, "../miniprogram/pages/subject-settings/subject-settings.js");
  const source = fs.readFileSync(sourcePath, "utf8");
  const calls = [];
  const toasts = [];
  let page;
  const subjectData = {
    subjects: ["语文", "道德与法治"],
    defaultSubjects: ["语文", "道德与法治"],
    customSubjects: [],
  };
  const context = vm.createContext({
    console,
    wx: {
      showToast(options) { toasts.push(options); },
      showModal() {},
    },
    Page(definition) {
      page = definition;
      page.setData = function setData(data) {
        Object.assign(this.data, data);
      };
    },
    require(request) {
      if (request === "../../utils/api") {
        return {
          async callFunction(name, action, data) {
            calls.push({ name, action, data });
            if (action === "getSubjects") return subjectData;
            if (action === "renameSubject") {
              return {
                subjects: ["语文", data.newSubject],
                defaultSubjects: subjectData.defaultSubjects,
                customSubjects: [data.newSubject],
              };
            }
            throw new Error(`测试未实现操作：${action}`);
          },
          showError() {},
        };
      }
      if (request === "../../utils/session") {
        return { async requireFamily() { return { user: { role: "creator" } }; } };
      }
      if (request === "../../utils/share") {
        return { createShareAppMessage() {}, createShareTimelineMessage() {} };
      }
      throw new Error(`测试未实现依赖：${request}`);
    },
  });
  vm.runInContext(source, context, { filename: sourcePath });
  return { page, calls, toasts };
}

test("科目管理允许修改系统推荐科目且明确保留历史作业", async () => {
  const fixture = loadSubjectSettingsPage();
  const template = fs.readFileSync(path.join(
    __dirname,
    "../miniprogram/pages/subject-settings/subject-settings.wxml",
  ), "utf8");

  await fixture.page.onLoad();
  fixture.page.beginRename({ currentTarget: { dataset: { subject: "道德与法治" } } });
  fixture.page.onRenameInput({ detail: { value: "政治" } });
  await fixture.page.rename();

  const renameCall = fixture.calls.find((item) => item.action === "renameSubject");
  assert.deepEqual(JSON.parse(JSON.stringify(renameCall)), {
    name: "settings",
    action: "renameSubject",
    data: { subject: "道德与法治", newSubject: "政治" },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.page.data.subjects)), ["语文", "政治"]);
  assert.equal(fixture.page.data.editingSubject, "");
  assert.equal(fixture.toasts.at(-1).title, "科目名称已修改");
  assert.match(template, /系统推荐科目不能直接删除/);
  assert.match(template, /不会批量改动历史作业/);
  assert.match(template, /data-subject="\{\{item\.name\}\}" bindtap="beginRename"/);
});
