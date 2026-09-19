const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadSettingsFunction({ role, currentSettings, currentSubjects = null, exportRecords = {} }) {
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
      if (Object.hasOwn(exportRecords, name)) {
        return {
          where(query) {
            const items = exportRecords[name].filter((item) => item.familyId === query.familyId);
            let offset = 0;
            let limit = items.length;
            const chain = {
              async count() { return { total: items.length }; },
              skip(value) { offset = value; return chain; },
              limit(value) { limit = value; return chain; },
              async get() { return { data: items.slice(offset, offset + limit) }; },
            };
            return chain;
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
    getUpdatedSettings: () => updatedSettings,
    getUpdatedSubjects: () => updatedSubjects,
  };
}

test("科目排序只交换相邻位置并保留全部名称和顺序映射", async () => {
  const fixture = loadSettingsFunction({ role: "creator", currentSubjects: { _id: "subjects-id", subjects: ["语文", "数学", "政治"] } });
  const result = await fixture.main({ action: "moveSubject", subject: "政治", offset: -1 });
  assert.equal(result.success, true);
  assert.deepEqual([...result.data.subjects], ["语文", "政治", "数学"]);
  assert.equal(fixture.getUpdatedSubjects().order["政治"], 1);
});

test("科目排序拒绝孩子、非法方向和不存在科目", async () => {
  for (const request of [
    { role: "child", subject: "数学", offset: -1 },
    { role: "creator", subject: "数学", offset: "-1" },
    { role: "creator", subject: "数学", offset: 9 },
    { role: "creator", subject: "不存在", offset: -1 },
  ]) {
    const fixture = loadSettingsFunction({ role: request.role, currentSubjects: { _id: "subjects-id", subjects: ["语文", "数学"] } });
    const result = await fixture.main({ action: "moveSubject", subject: request.subject, offset: request.offset });
    assert.equal(result.success, false);
    assert.equal(fixture.getUpdatedSubjects(), null);
  }
});

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

test("家庭识别词库仅保存有效且不重复的人工提示", async () => {
  const fixture = loadSettingsFunction({ role: "creator", currentSettings: null });
  const result = await fixture.main({
    action: "updatePreferences",
    reminderDefaultAdvance: [120],
    reminderTargets: ["father"],
    recognitionGlossary: [
      { term: "小单行本", hint: "语文作业本" },
      { term: "中考语文", hint: "教材名称" },
    ],
  });

  assert.equal(result.success, true);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.getUpdatedSettings().recognitionGlossary)), [
    { term: "小单行本", hint: "语文作业本" },
    { term: "中考语文", hint: "教材名称" },
  ]);
});

test("家庭识别词库拒绝重复词条和超长内容", async () => {
  for (const recognitionGlossary of [
    [{ term: "卷", hint: "试卷" }, { term: "卷", hint: "重复" }],
    [{ term: "词".repeat(21), hint: "说明" }],
    Array.from({ length: 31 }, (_, index) => ({ term: `词${index}`, hint: "说明" })),
  ]) {
    const fixture = loadSettingsFunction({ role: "creator", currentSettings: null });
    const result = await fixture.main({
      action: "updatePreferences",
      reminderDefaultAdvance: [120],
      reminderTargets: ["father"],
      recognitionGlossary,
    });
    assert.equal(result.success, false);
    assert.equal(fixture.getUpdatedSettings(), null);
  }
});

test("家庭数据导出仅限创建者且移除内部身份和连接字段", async () => {
  const record = {
    _id: "homework-id",
    familyId: "family-id",
    title: "数学练习",
    createdBy: "sensitive-openid",
    checkedByOpenid: "another-openid",
    nested: { token: "secret-token", visible: "保留" },
  };
  const creator = loadSettingsFunction({ role: "creator", currentSettings: null, exportRecords: { homework: [record] } });
  const result = await creator.main({ action: "exportDataPage", dataset: "homework", offset: 0 });
  assert.equal(result.success, true);
  assert.equal(result.data.items[0].title, "数学练习");
  assert.equal(result.data.items[0].nested.visible, "保留");
  assert.equal(Object.hasOwn(result.data.items[0], "createdBy"), false);
  assert.equal(Object.hasOwn(result.data.items[0], "checkedByOpenid"), false);
  assert.equal(Object.hasOwn(result.data.items[0].nested, "token"), false);

  const member = loadSettingsFunction({ role: "member", currentSettings: null, exportRecords: { homework: [record] } });
  const denied = await member.main({ action: "exportDataPage", dataset: "homework", offset: 0 });
  assert.equal(denied.success, false);
  assert.match(denied.message, /家庭创建者/);
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
