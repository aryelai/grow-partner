const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadModule(options = {}) {
  const sourcePath = path.join(__dirname, "../cloudfunctions/timetable/index.js");
  const moduleValue = { exports: {} };
  const context = vm.createContext({
    console: { error() {} },
    Date,
    module: moduleValue,
    exports: moduleValue.exports,
    require(request) {
      if (request === "wx-server-sdk") return {
        DYNAMIC_CURRENT_ENV: "test",
        init() {},
        database: () => options.database || { collection() { throw new Error("数据库不应被访问"); } },
        getWXContext: () => options.context || {},
      };
      if (request === "./core") return require("../cloudfunctions/timetable/core");
      throw new Error(`测试未实现依赖：${request}`);
    },
  });
  vm.runInContext(fs.readFileSync(sourcePath, "utf8"), context, { filename: sourcePath });
  return moduleValue.exports;
}

function createFixture(role = "creator") {
  const documents = new Map();
  const users = [{ openid: "openid-1", familyId: "family-1", role }];
  function missing() {
    const error = new Error("document.get:fail document does not exist");
    error.code = "DOCUMENT_NOT_FOUND";
    return error;
  }
  function collection(name, storage = documents) {
    if (name === "users") return { where(query) { return { limit() { return { async get() {
      return { data: users.filter((user) => user.openid === query.openid).map((user) => structuredClone(user)) };
    } }; } }; } };
    if (name === "families") return { doc(id) { return { async get() {
      if (id !== "family-1") throw missing();
      return { data: { _id: id, currentSemester: "2026下" } };
    } }; } };
    if (name === "timetables") return { doc(id) { return {
      async get() {
        if (!storage.has(id)) throw missing();
        return { data: structuredClone(storage.get(id)) };
      },
      async set({ data }) { storage.set(id, structuredClone(data)); },
    }; } };
    throw new Error(`测试未实现集合：${name}`);
  }
  const database = {
    collection,
    async runTransaction(callback) {
      const staged = structuredClone(documents);
      const result = await callback({ collection: (name) => collection(name, staged) });
      documents.clear();
      for (const [key, value] of staged) documents.set(key, value);
      return result;
    },
  };
  const { createTimetableService } = loadModule({ database });
  return {
    service: createTimetableService({ database, now: () => new Date("2026-09-15T08:00:00.000Z") }),
    documents,
    users,
  };
}

const chinese = (value) => JSON.parse(JSON.stringify(value));

test("所有家庭角色可读取当前学期课程表且空表版本为零", async () => {
  for (const role of ["creator", "member", "child"]) {
    const fixture = createFixture(role);
    assert.deepEqual(chinese(await fixture.service.get("openid-1")), {
      semester: "2026下",
      version: 0,
      entries: [],
      overrides: [],
    });
  }
});

test("创建者和普通成员可保存课程格且孩子被服务端拒绝", async () => {
  for (const role of ["creator", "member"]) {
    const fixture = createFixture(role);
    const result = await fixture.service.saveEntry("openid-1", {
      expectedVersion: 0,
      entry: { dayOfWeek: 1, period: 1, courseName: "语文", teacher: "李老师", location: "101", startTime: "08:00", endTime: "08:40" },
      familyId: "forged-family",
      semester: "2027上",
    });
    assert.equal(result.version, 1);
    assert.equal(result.entries[0].courseName, "语文");
    const stored = [...fixture.documents.values()][0];
    assert.equal(stored.familyId, "family-1");
    assert.equal(stored.semester, "2026下");
    assert.equal(stored.updatedBy, "openid-1");
  }
  const child = createFixture("child");
  await assert.rejects(child.service.saveEntry("openid-1", {
    expectedVersion: 0,
    entry: { dayOfWeek: 1, period: 1, courseName: "语文" },
  }), { message: "FORBIDDEN" });
  assert.equal(child.documents.size, 0);
});

test("旧版本写入返回冲突且不会覆盖较新课程表", async () => {
  const fixture = createFixture();
  await fixture.service.saveEntry("openid-1", {
    expectedVersion: 0,
    entry: { dayOfWeek: 1, period: 1, courseName: "语文" },
  });
  await assert.rejects(fixture.service.saveEntry("openid-1", {
    expectedVersion: 0,
    entry: { dayOfWeek: 1, period: 1, courseName: "数学" },
  }), { message: "VERSION_CONFLICT" });
  assert.equal((await fixture.service.get("openid-1")).entries[0].courseName, "语文");
});

test("已存在课程表的非法版本不会被当作空表覆盖", async () => {
  const fixture = createFixture();
  const { buildTimetableId } = require("../cloudfunctions/timetable/core");
  const id = buildTimetableId("family-1", "2026下");
  fixture.documents.set(id, {
    familyId: "family-1",
    semester: "2026下",
    version: "1",
    entries: [{ dayOfWeek: 1, period: 1, courseName: "语文" }],
  });

  await assert.rejects(fixture.service.get("openid-1"), { message: "INVALID_DOCUMENT" });
  await assert.rejects(fixture.service.saveEntry("openid-1", {
    expectedVersion: 0,
    entry: { dayOfWeek: 1, period: 1, courseName: "数学" },
  }), { message: "INVALID_DOCUMENT" });
  assert.equal(fixture.documents.get(id).entries[0].courseName, "语文");
});

test("批量合并返回覆盖统计且删除课程格递增版本", async () => {
  const fixture = createFixture();
  await fixture.service.saveEntry("openid-1", {
    expectedVersion: 0,
    entry: { dayOfWeek: 1, period: 1, courseName: "语文" },
  });
  const merged = await fixture.service.mergeEntries("openid-1", {
    expectedVersion: 1,
    entries: [
      { dayOfWeek: 1, period: 1, courseName: "数学" },
      { dayOfWeek: 2, period: 1, courseName: "英语" },
    ],
  });
  assert.deepEqual(chinese({ version: merged.version, addedCount: merged.addedCount, replacedCount: merged.replacedCount }), {
    version: 2,
    addedCount: 1,
    replacedCount: 1,
  });
  const removed = await fixture.service.removeEntry("openid-1", { expectedVersion: 2, dayOfWeek: 1, period: 1 });
  assert.equal(removed.version, 3);
  assert.deepEqual(removed.entries.map((entry) => entry.courseName), ["英语"]);
});

test("临时调课和停课独立于每周课程并可恢复", async () => {
  const fixture = createFixture();
  await fixture.service.saveEntry("openid-1", {
    expectedVersion: 0,
    entry: { dayOfWeek: 5, period: 1, courseName: "语文" },
  });
  const changed = await fixture.service.saveOverride("openid-1", {
    expectedVersion: 1,
    override: { date: "2026-09-18", period: 1, isCancelled: false, courseName: "班会" },
  });
  assert.equal(changed.version, 2);
  assert.equal(changed.entries[0].courseName, "语文");
  assert.equal(changed.overrides[0].courseName, "班会");

  const cancelled = await fixture.service.saveOverride("openid-1", {
    expectedVersion: 2,
    override: { date: "2026-09-18", period: 1, isCancelled: true },
  });
  assert.equal(cancelled.overrides[0].isCancelled, true);
  const restored = await fixture.service.removeOverride("openid-1", {
    expectedVersion: 3,
    date: "2026-09-18",
    period: 1,
  });
  assert.equal(restored.version, 4);
  assert.deepEqual(chinese(restored.overrides), []);
  assert.equal(restored.entries[0].courseName, "语文");
});

test("无身份和非法角色不能读取课程表", async () => {
  const fixture = createFixture("unknown");
  await assert.rejects(fixture.service.get(""), { message: "UNAUTHORIZED" });
  await assert.rejects(fixture.service.get("openid-1"), { message: "UNAUTHORIZED" });
});
