const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadSettingsFunction({ role, currentSettings, currentSubjects = null }) {
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
  let updatedSubjects = null;
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
      if (name === "subjects") {
        return {
          where() { return queryResult(currentSubjects ? [currentSubjects] : []); },
          doc() {
            return { async update({ data }) { updatedSubjects = data; } };
          },
          async add({ data }) { updatedSubjects = data; },
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
    getUpdatedSubjects: () => updatedSubjects,
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

test("家庭默认提醒只保存一个有效值", async () => {
  const fixture = loadSettingsFunction({ role: "creator", currentSettings: null });

  const result = await fixture.main({
    action: "updatePreferences",
    reminderDefaultAdvance: [1440, 120],
    reminderTargets: ["father"],
  });

  assert.equal(result.success, false);
  assert.equal(result.message, "默认提醒时间只能选择一个");
});

test("家庭默认提醒拒绝混入无效值", async () => {
  const fixture = loadSettingsFunction({ role: "creator", currentSettings: null });

  const result = await fixture.main({
    action: "updatePreferences",
    reminderDefaultAdvance: [120, "invalid"],
    reminderTargets: ["father"],
  });

  assert.equal(result.success, false);
  assert.equal(result.message, "默认提醒时间只能选择一个");
});

test("读取历史家庭设置时默认提醒始终是一个有效值", async () => {
  const fixture = loadSettingsFunction({
    role: "creator",
    currentSettings: {
      _id: "settings-id",
      familyId: "family-id",
      reminderDefaultAdvance: [1440, 120],
      reminderTargets: ["father"],
    },
  });

  const result = await fixture.main({ action: "get" });

  assert.equal(result.success, true);
  assert.deepEqual([...result.data.settings.reminderDefaultAdvance], [120]);
});

test("家庭创建者可以重命名默认科目且不修改默认模板", async () => {
  const fixture = loadSettingsFunction({ role: "creator", currentSettings: null });

  const result = await fixture.main({
    action: "renameSubject",
    subject: "道德与法治",
    newSubject: "政治",
  });

  assert.equal(result.success, true);
  assert.equal(result.data.subjects.includes("道德与法治"), false);
  assert.equal(result.data.subjects.includes("政治"), true);
  assert.equal(result.data.defaultSubjects.includes("道德与法治"), true);
  assert.equal(result.data.defaultSubjects.includes("政治"), false);
  assert.equal(fixture.getUpdatedSubjects().subjects.includes("政治"), true);
});

test("科目重命名拒绝不存在的源科目和重复名称", async () => {
  const currentSubjects = {
    _id: "subjects-id",
    subjects: ["语文", "数学", "政治"],
    customSubjects: ["政治"],
  };
  const fixture = loadSettingsFunction({ role: "creator", currentSettings: null, currentSubjects });

  const missing = await fixture.main({ action: "renameSubject", subject: "历史", newSubject: "地理" });
  const duplicate = await fixture.main({ action: "renameSubject", subject: "政治", newSubject: "数学" });

  assert.equal(missing.success, false);
  assert.equal(missing.message, "原科目不存在，请刷新后重试");
  assert.equal(duplicate.success, false);
  assert.equal(duplicate.message, "该科目名称已存在");
  assert.equal(fixture.getUpdatedSubjects(), null);
});
