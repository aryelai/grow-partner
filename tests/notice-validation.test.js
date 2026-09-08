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
      throw new Error(`测试未实现依赖：${request}`);
    },
  });
  vm.runInContext(source, context, { filename: sourcePath });
  return {
    main: moduleValue.exports.main,
    getCreatedNotice: () => createdNotice,
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
