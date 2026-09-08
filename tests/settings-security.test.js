const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadSettingsFunction({ role, currentSettings }) {
  const sourcePath = path.join(__dirname, "../cloudfunctions/settings/index.js");
  const source = fs.readFileSync(sourcePath, "utf8");
  const user = {
    _id: "user-id",
    openid: "test-openid",
    nickname: "测试用户",
    familyId: "family-id",
    relation: role === "creator" ? "father" : "mother",
    role,
  };
  const family = {
    _id: "family-id",
    educationStage: "junior_high",
    grade: "1",
    allowMemberEditSettings: true,
  };
  let updatedSettings = null;
  const queryResult = (data) => ({ limit() { return { async get() { return { data }; } }; } });
  const database = {
    collection(name) {
      if (name === "users") return { where() { return queryResult([user]); } };
      if (name === "families") {
        return {
          doc() {
            return {
              async get() { return { data: family }; },
              async update() {},
            };
          },
        };
      }
      if (name === "settings") {
        return {
          where() { return queryResult(currentSettings ? [currentSettings] : []); },
          doc() {
            return { async update({ data }) { updatedSettings = data; } };
          },
          async add({ data }) { updatedSettings = data; },
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
    getUpdatedSettings: () => updatedSettings,
  };
}

test("普通成员修改设置时不能改写AI配置", async () => {
  const fixture = loadSettingsFunction({
    role: "member",
    currentSettings: {
      _id: "settings-id",
      familyId: "family-id",
      aiEnabled: false,
      aiProvider: "deepseek",
      aiBaseUrl: "https://api.example.com",
      aiModel: "safe-model",
      reminderDefaultAdvance: [1440, 120],
      reminderTargets: ["father", "mother"],
      allowMemberEditSettings: true,
    },
  });

  const result = await fixture.main({
    action: "updatePreferences",
    aiProvider: "custom",
    aiBaseUrl: "http://127.0.0.1/internal",
    aiModel: "changed-model",
    reminderDefaultAdvance: [120],
    reminderTargets: ["mother"],
  });

  assert.equal(result.success, true);
  assert.equal(fixture.getUpdatedSettings().aiProvider, "deepseek");
  assert.equal(fixture.getUpdatedSettings().aiBaseUrl, "https://api.example.com");
  assert.equal(fixture.getUpdatedSettings().aiModel, "safe-model");
  assert.deepEqual([...fixture.getUpdatedSettings().reminderDefaultAdvance], [120]);
  assert.deepEqual([...fixture.getUpdatedSettings().reminderTargets], ["mother"]);
});

test("提醒对象只保存受支持的家庭关系", async () => {
  const fixture = loadSettingsFunction({
    role: "creator",
    currentSettings: {
      _id: "settings-id",
      familyId: "family-id",
      aiEnabled: false,
      aiProvider: "deepseek",
      aiBaseUrl: "",
      aiModel: "",
      reminderDefaultAdvance: [1440, 120],
      reminderTargets: ["father", "mother"],
      allowMemberEditSettings: true,
    },
  });

  const result = await fixture.main({
    action: "updatePreferences",
    reminderDefaultAdvance: [1440],
    reminderTargets: ["father", "unsupported", "child"],
  });

  assert.equal(result.success, true);
  assert.deepEqual([...fixture.getUpdatedSettings().reminderTargets], ["father", "child"]);
});
