const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

function fixture(options = {}) {
  const sourcePath = path.resolve(__dirname, "../cloudfunctions/notice/index.js");
  const requireLocal = createRequire(sourcePath);
  const user = { openid: "test-user", familyId: "family-1", role: options.role || "creator", relation: "father", nickname: "家长" };
  let items = structuredClone(options.items || [{ _id: "notice-1", familyId: "family-1", semester: "2026下", title: "测试通知", category: "activity", reminderState: "completed", isReminded: true, reminderVersion: 3 }]);
  const updates = [];
  const matches = (item, query) => Object.entries(query).every(([key, value]) => value && value.neq !== undefined ? item[key] !== value.neq : item[key] === value);
  const database = {
    command: { neq(value) { return { neq: value }; } },
    collection(name) {
      if (name === "users") return { where() { return { limit() { return { async get() { return { data: [user] }; } }; } }; } };
      assert.equal(name, "notices");
      return {
        where(query) {
          let skip = 0;
          let limit = 20;
          const chain = {
            async count() { return { total: items.filter((item) => matches(item, query)).length }; },
            orderBy() { return chain; },
            skip(value) { skip = value; return chain; },
            limit(value) { limit = value; return chain; },
            async get() { return { data: structuredClone(items.filter((item) => matches(item, query)).slice(skip, skip + limit)) }; },
          };
          return chain;
        },
        doc(id) {
          return {
            async get() { return { data: structuredClone(items.find((item) => item._id === id) || null) }; },
            async update({ data }) { updates.push(structuredClone(data)); items = items.map((item) => item._id === id ? { ...item, ...structuredClone(data) } : item); },
          };
        },
        async add({ data }) { items.push({ _id: "new-notice", ...data }); return { _id: "new-notice" }; },
      };
    },
    async runTransaction(callback) { return callback(database); },
  };
  const exportsValue = {};
  vm.runInNewContext(fs.readFileSync(sourcePath, "utf8"), {
    exports: exportsValue, Date, console: { error() {} },
    require(request) {
      if (request === "wx-server-sdk") return { init() {}, DYNAMIC_CURRENT_ENV: "test", database() { return database; }, getWXContext() { return { OPENID: user.openid }; } };
      return requireLocal(request);
    },
  }, { filename: sourcePath });
  return { main: exportsValue.main, updates, items: () => items };
}

test("历史通知默认待处理且提醒已发送不代表事项已完成", async () => {
  const current = fixture();
  const pending = await current.main({ action: "list", status: "pending", semester: "2026下" });
  assert.equal(pending.success, true);
  assert.equal(pending.data.total, 1);
  assert.equal(pending.data.items[0].isCompleted, false);
  const completed = await current.main({ action: "list", status: "completed" });
  assert.equal(completed.data.total, 0);
});

test("通知完成接口按明确状态幂等写入并保持提醒配置不变", async () => {
  const current = fixture();
  for (let index = 0; index < 2; index += 1) {
    const result = await current.main({ action: "toggleCompleted", id: "notice-1", isCompleted: true });
    assert.equal(result.success, true);
    assert.equal(result.data.isCompleted, true);
  }
  assert.equal(current.items()[0].isCompleted, true);
  assert.equal(current.items()[0].reminderState, "completed");
  assert.equal(current.items()[0].isReminded, true);
  assert.equal(current.items()[0].reminderVersion, 3);
  assert.ok(current.updates.every((data) => !Object.keys(data).some((key) => /^remind|^scheduled|^isReminded/.test(key))));
  const result = await current.main({ action: "toggleCompleted", id: "notice-1", isCompleted: false });
  assert.equal(result.success, true);
  assert.equal(current.items()[0].isCompleted, false);
  assert.equal(current.items()[0].completedAt, null);
});

test("通知拒绝非布尔完成目标和非法编号且不写入", async () => {
  const current = fixture();
  for (const isCompleted of ["true", 1, null, undefined]) assert.equal((await current.main({ action: "toggleCompleted", id: "notice-1", isCompleted })).success, false);
  assert.equal((await current.main({ action: "toggleCompleted", id: "../notice-1", isCompleted: true })).success, false);
  assert.equal(current.updates.length, 0);
});

test("孩子及跨家庭不能完成通知，普通成人成员可以", async () => {
  const child = fixture({ role: "child" });
  assert.equal((await child.main({ action: "toggleCompleted", id: "notice-1", isCompleted: true })).success, false);
  assert.equal(child.updates.length, 0);
  const foreign = fixture({ items: [{ _id: "notice-1", familyId: "family-2", title: "其他家庭" }] });
  assert.equal((await foreign.main({ action: "toggleCompleted", id: "notice-1", isCompleted: true })).success, false);
  assert.equal(foreign.updates.length, 0);
  const member = fixture({ role: "member" });
  assert.equal((await member.main({ action: "toggleCompleted", id: "notice-1", isCompleted: true })).success, true);
});

test("通知状态和分类在分页前组合过滤", async () => {
  const current = fixture({ items: [
    { _id: "old", familyId: "family-1", category: "activity" },
    { _id: "done", familyId: "family-1", category: "activity", isCompleted: true },
    { _id: "exam", familyId: "family-1", category: "exam", isCompleted: true },
  ] });
  const result = await current.main({ action: "list", status: "completed", category: "activity", pageSize: 1 });
  assert.equal(result.data.total, 1);
  assert.equal(result.data.items[0]._id, "done");
  assert.equal(result.data.hasMore, false);
});

test("新通知默认未完成且外部载荷不能覆盖完成和提醒审计状态", async () => {
  const current = fixture();
  const result = await current.main({ action: "create", semester: "2026下", title: "新通知", category: "activity", isCompleted: true, completedAt: "forged" });
  assert.equal(result.success, true);
  assert.equal(current.items().find((item) => item._id === "new-notice").isCompleted, false);
});

test("旧通知默认空要求清单且成人可原子更新单项完成状态", async () => {
  const current = fixture({ items: [{
    _id: "notice-1",
    familyId: "family-1",
    semester: "2026下",
    title: "家长会准备",
    category: "activity",
    requirements: [
      { id: "requirement_01", text: "填写回执", isCompleted: false },
      { id: "requirement_02", text: "准备笔记本", isCompleted: false },
    ],
  }] });
  const updated = await current.main({ action: "toggleRequirement", id: "notice-1", requirementId: "requirement_02", isCompleted: true });
  assert.equal(updated.success, true);
  assert.equal(current.items()[0].requirements[0].isCompleted, false);
  assert.equal(current.items()[0].requirements[1].isCompleted, true);
  assert.equal(updated.data.completedCount, 1);
  assert.equal(updated.data.totalCount, 2);

  const legacy = fixture({ items: [{ _id: "notice-1", familyId: "family-1", title: "旧通知" }] });
  const result = await legacy.main({ action: "get", id: "notice-1" });
  assert.equal(result.data.requirements.length, 0);
});

test("通知要求清单拒绝非法单项、重复编号和孩子越权更新", async () => {
  const invalid = fixture();
  const created = await invalid.main({
    action: "create",
    semester: "2026下",
    title: "测试通知",
    category: "activity",
    requirements: [
      { id: "duplicate_01", text: "第一项", isCompleted: false },
      { id: "duplicate_01", text: "第二项", isCompleted: false },
    ],
  });
  assert.equal(created.success, false);
  assert.match(created.message, /要求清单/);

  const child = fixture({ role: "child", items: [{
    _id: "notice-1", familyId: "family-1", title: "通知", requirements: [{ id: "requirement_01", text: "回执", isCompleted: false }],
  }] });
  assert.equal((await child.main({ action: "toggleRequirement", id: "notice-1", requirementId: "requirement_01", isCompleted: true })).success, false);
  assert.equal(child.items()[0].requirements[0].isCompleted, false);
});
