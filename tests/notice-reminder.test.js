const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { buildReminderFields } = require("../cloudfunctions/notice/reminder-policy");

function loadNoticeFunction() {
  const sourcePath = path.join(__dirname, "../cloudfunctions/notice/index.js");
  const source = fs.readFileSync(sourcePath, "utf8");
  const user = {
    _id: "user-id",
    openid: "test-openid",
    nickname: "测试用户",
    familyId: "family-id",
    relation: "father",
    role: "creator",
  };
  let createdNotice = null;
  const queryResult = (data) => ({ limit() { return { async get() { return { data }; } }; } });
  const database = {
    collection(name) {
      if (name === "users") return { where() { return queryResult([user]); } };
      if (name === "notices") {
        return {
          async add({ data }) {
            createdNotice = data;
            return { _id: "notice-id" };
          },
        };
      }
      throw new Error(`测试未实现集合：${name}`);
    },
  };
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
    module: moduleValue,
    exports: moduleValue.exports,
    require(request) {
      if (request === "wx-server-sdk") return cloud;
      if (request === "./reminder-policy") {
        const policyPath = path.join(__dirname, "../cloudfunctions/notice/reminder-policy.js");
        const policyModule = { exports: {} };
        const policyContext = vm.createContext({
          Date,
          Error,
          module: policyModule,
          exports: policyModule.exports,
        });
        vm.runInContext(fs.readFileSync(policyPath, "utf8"), policyContext, { filename: policyPath });
        return policyModule.exports;
      }
      throw new Error(`测试未实现依赖：${request}`);
    },
  });
  vm.runInContext(source, context, { filename: sourcePath });
  return { main: moduleValue.exports.main, getCreatedNotice: () => createdNotice };
}

test("提前两小时生成调度时间和首个提醒版本", async () => {
  const fixture = loadNoticeFunction();
  const result = await fixture.main({
    action: "create",
    semester: "2026下",
    title: "家长会",
    category: "activity",
    remindTime: "2026-09-10T12:00:00.000Z",
    remindAdvance: [120],
    remindTargets: ["father"],
  });

  assert.equal(result.success, true);
  assert.equal(fixture.getCreatedNotice().scheduledAt.toISOString(), "2026-09-10T10:00:00.000Z");
  assert.equal(fixture.getCreatedNotice().reminderVersion, 1);
  assert.equal(fixture.getCreatedNotice().reminderState, "scheduled");
  assert.equal(fixture.getCreatedNotice().isReminded, false);
});

test("历史通知重新开启提醒时从首个版本开始调度", () => {
  const fields = buildReminderFields({
    remindTime: new Date("2026-09-10T12:00:00.000Z"),
    remindAdvance: [1440],
    remindTargets: ["father"],
  }, {
    remindTime: null,
    remindAdvance: [],
    remindTargets: [],
  });

  assert.equal(fields.reminderVersion, 1);
  assert.equal(fields.reminderState, "scheduled");
  assert.equal(fields.scheduledAt.toISOString(), "2026-09-09T12:00:00.000Z");
});

test("仅修改通知标题不创建新的提醒版本", () => {
  const fields = buildReminderFields({
    title: "更新后的家长会标题",
    remindTime: new Date("2026-09-10T12:00:00.000Z"),
    remindAdvance: [120],
    remindTargets: ["father"],
  }, {
    title: "原家长会标题",
    remindTime: new Date("2026-09-10T12:00:00.000Z"),
    remindAdvance: [120],
    remindTargets: ["father"],
    reminderVersion: 2,
    reminderState: "materialized",
    isReminded: true,
  });

  assert.equal(fields.reminderVersion, 2);
  assert.equal(fields.reminderState, "materialized");
  assert.equal(fields.isReminded, true);
});
