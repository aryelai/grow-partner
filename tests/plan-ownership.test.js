const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadPlanFunction(options = {}) {
  const sourcePath = path.resolve(__dirname, "../cloudfunctions/plan/index.js");
  const user = {
    openid: options.openid || "child-openid",
    familyId: "family-1",
    role: options.role || "child",
    relation: options.role === "child" || !options.role ? "child" : "father",
    nickname: "成员",
  };
  const plans = new Map((options.plans || []).map((item) => [item._id, structuredClone(item)]));
  let sequence = 0;
  const database = {
    command: { gte(value) { return { and() { return value; } }; } },
    collection(name) {
      if (name === "users") return { where() { return { limit() { return { async get() { return { data: [user] }; } }; } }; } };
      assert.equal(name, "plans");
      return {
        doc(id) {
          return {
            async get() {
              const item = plans.get(id);
              if (!item) throw new Error("document does not exist");
              return { data: { ...structuredClone(item), _id: id } };
            },
            async update({ data }) { plans.set(id, { ...plans.get(id), ...structuredClone(data) }); },
            async remove() { plans.delete(id); },
          };
        },
        async add({ data }) {
          sequence += 1;
          const id = `plan-${sequence}`;
          plans.set(id, structuredClone(data));
          return { _id: id };
        },
      };
    },
  };
  const moduleValue = { exports: {} };
  vm.runInNewContext(fs.readFileSync(sourcePath, "utf8"), {
    module: moduleValue,
    exports: moduleValue.exports,
    Date,
    console: { error() {} },
    require(request) {
      assert.equal(request, "wx-server-sdk");
      return { DYNAMIC_CURRENT_ENV: "test", init() {}, database() { return database; }, getWXContext() { return { OPENID: user.openid }; } };
    },
  }, { filename: sourcePath });
  return { main: moduleValue.exports.main, plans };
}

function planInput(overrides = {}) {
  return {
    action: "create",
    type: "daily",
    date: "2026-09-19",
    semester: "2026下",
    title: "我的晚间计划",
    assignee: "child",
    items: [{ text: "完成错题整理", isDone: false, priority: "medium" }],
    notes: "",
    linkedHomeworkIds: [],
    linkedHabitIds: [],
    ...overrides,
  };
}

test("孩子只能创建由自己执行的计划", async () => {
  const fixture = loadPlanFunction();
  const created = await fixture.main(planInput());
  assert.equal(created.success, true);
  assert.equal(fixture.plans.get(created.data.id).createdBy, "child-openid");
  assert.equal(fixture.plans.get(created.data.id).assignee, "child");

  const forbidden = await fixture.main(planInput({ assignee: "all" }));
  assert.equal(forbidden.success, false);
  assert.match(forbidden.message, /只能创建由自己执行/);
});

test("孩子只能修改和删除自己创建且由自己执行的计划", async () => {
  const fixture = loadPlanFunction({ plans: [
    { _id: "own", familyId: "family-1", createdBy: "child-openid", assignee: "child", title: "自己的计划", items: [{ text: "任务", isDone: false }] },
    { _id: "adult", familyId: "family-1", createdBy: "adult-openid", assignee: "child", title: "家长计划", items: [{ text: "任务", isDone: false }] },
  ] });
  assert.equal((await fixture.main(planInput({ action: "update", id: "own", title: "更新后的计划" }))).success, true);
  assert.equal(fixture.plans.get("own").title, "更新后的计划");
  assert.equal((await fixture.main(planInput({ action: "update", id: "own", assignee: "father" }))).success, false);
  assert.equal((await fixture.main(planInput({ action: "update", id: "adult" }))).success, false);
  assert.equal((await fixture.main({ action: "remove", id: "adult" })).success, false);
  assert.equal((await fixture.main({ action: "remove", id: "own" })).success, true);
  assert.equal(fixture.plans.has("own"), false);
});

test("计划公开结果只返回服务端计算的编辑权限", async () => {
  const own = loadPlanFunction({ plans: [{ _id: "own", familyId: "family-1", createdBy: "child-openid", assignee: "child", title: "自己的计划", items: [] }] });
  const adult = loadPlanFunction({ plans: [{ _id: "adult", familyId: "family-1", createdBy: "adult-openid", assignee: "child", title: "家长计划", items: [] }] });
  const ownResult = await own.main({ action: "get", id: "own" });
  const adultResult = await adult.main({ action: "get", id: "adult" });
  assert.equal(ownResult.data.canEdit, true);
  assert.equal(ownResult.data.createdBy, undefined);
  assert.equal(adultResult.data.canEdit, false);
});
