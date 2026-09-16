const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

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
  const notices = [];
  const findNotice = (id) => notices.find((item) => item._id === id);
  const noticeReference = (id) => ({
    async get() {
      const item = findNotice(id);
      if (!item) {
        const error = new Error("document does not exist");
        error.code = "DOCUMENT_NOT_FOUND";
        throw error;
      }
      return { data: item };
    },
    async set({ data }) {
      createdNotice = data;
      const existingIndex = notices.findIndex((item) => item._id === id);
      const item = { _id: id, ...data };
      if (existingIndex >= 0) notices[existingIndex] = item;
      else notices.push(item);
    },
  });
  const queryResult = (data) => ({ limit() { return { async get() { return { data }; } }; } });
  const database = {
    async runTransaction(callback) { return callback(database); },
    collection(name) {
      if (name === "users") return { where() { return queryResult([user]); } };
      if (name === "notices") {
        return {
          where(query) {
            return queryResult(notices.filter((item) => Object.entries(query).every(([key, value]) => item[key] === value)));
          },
          async add({ data }) {
            createdNotice = data;
            notices.push({ _id: `notice-${notices.length + 1}`, ...data });
            return { _id: "notice-id" };
          },
          doc(id) { return noticeReference(id); },
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
      if (request === "crypto") return require("node:crypto");
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
  return {
    main: moduleValue.exports.main,
    getCreatedNotice: () => createdNotice,
    getNotices: () => notices,
  };
}

test("通知提醒对象只保存受支持的家庭关系", async () => {
  const fixture = loadNoticeFunction();

  const result = await fixture.main({
    action: "create",
    semester: "2026下",
    title: "测试通知",
    category: "other",
    remindAdvance: [1440],
    remindTargets: ["father", "unsupported", "child"],
  });

  assert.equal(result.success, true);
  assert.deepEqual([...fixture.getCreatedNotice().remindTargets], ["father", "child"]);
});

test("通知只接受一个有效提前时间", async () => {
  const fixture = loadNoticeFunction();

  const result = await fixture.main({
    action: "create",
    semester: "2026下",
    title: "家长会",
    category: "activity",
    remindTime: "2026-09-10T12:00:00.000Z",
    remindAdvance: [1440, 120],
    remindTargets: ["father"],
  });

  assert.equal(result.success, false);
  assert.equal(result.message, "每条通知只能选择一个提醒时间");
});

test("通知拒绝混入无效值的提前时间", async () => {
  const fixture = loadNoticeFunction();

  const result = await fixture.main({
    action: "create",
    semester: "2026下",
    title: "家长会",
    category: "activity",
    remindTime: "2026-09-10T12:00:00.000Z",
    remindAdvance: [120, "invalid"],
    remindTargets: ["father"],
  });

  assert.equal(result.success, false);
  assert.equal(result.message, "每条通知只能选择一个提醒时间");
});

test("通知事项和截止时间独立保存，非法日历及时间拒绝写入", async () => {
  const base = { action: "create", semester: "2026下", title: "考试安排", category: "exam" };
  const fixture = loadNoticeFunction();
  assert.equal((await fixture.main({ ...base, eventTime: "2026-09-16T08:00:00+08:00", deadline: null })).success, true);
  assert.equal(fixture.getCreatedNotice().eventTime.toISOString(), "2026-09-16T00:00:00.000Z");
  assert.equal(fixture.getCreatedNotice().remindTime, null);
  for (const invalid of [false, {}, 123, "2026-02-30T08:00:00Z", "2026-09-16T24:00:00Z", "2026-09-16T08:60:00Z", "2026-09-16T08:00:00+15:00"]) {
    assert.equal((await loadNoticeFunction().main({ ...base, eventTime: invalid })).success, false);
  }
});

test("AI 通知批量保存重试使用请求编号避免重复创建", async () => {
  const fixture = loadNoticeFunction();
  const payload = {
    action: "create",
    semester: "2026下",
    title: "家长会",
    category: "activity",
    clientRequestId: "01010101010101010101010101010101_0",
  };

  const first = await fixture.main(payload);
  const retry = await fixture.main(payload);

  assert.equal(first.success, true);
  assert.equal(retry.success, true);
  assert.equal(fixture.getNotices().length, 1);
  assert.equal(retry.data.id, fixture.getNotices()[0]._id);
  assert.equal(first.data.created, true);
  assert.equal(retry.data.created, false);
});
