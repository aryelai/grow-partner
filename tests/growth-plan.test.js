const assert = require("node:assert/strict");
const test = require("node:test");
const { createPlanController, createPlanData, shiftPlanDate } = require("../miniprogram/utils/plan-controller");

function fixture(options = {}) {
  const calls = [];
  const errors = [];
  const session = options.session === undefined ? { user: { role: "member" }, family: { currentSemester: "2026下" } } : options.session;
  const controller = createPlanController({ requireFamily: async () => session,
    callFunction: options.request || (async (...args) => { calls.push(args); return { items: [{ _id: "plan-1", items: [{ text: "任务", isDone: false }] }] }; }),
    showError: (error) => errors.push(error), wxApi: { showToast() {}, navigateTo() {}, showModal() {} } });
  const page = { data: createPlanData(), setData(values) { Object.assign(this.data, values); } };
  for (const [key, method] of Object.entries(controller)) page[key] = method;
  return { page, calls, errors };
}

test("计划支持日周月区间，月末向前向后不跳过月份", async () => {
  assert.equal(shiftPlanDate("2026-01-31", "monthly", 1), "2026-02-01");
  assert.equal(shiftPlanDate("2026-03-31", "monthly", -1), "2026-02-01");
  const { page, calls } = fixture();
  page.data.anchorDate = "2026-09-15";
  await page.refresh();
  assert.equal(calls[0][2].start, "2026-09-15");
  await page.selectType({ currentTarget: { dataset: { value: "weekly" } } });
  assert.equal(calls[1][2].start, "2026-09-14");
  assert.equal(calls[1][2].end, "2026-09-20");
  await page.selectType({ currentTarget: { dataset: { value: "monthly" } } });
  assert.equal(calls[2][2].end, "2026-09-30");
});

test("游客计划可勾选并保留本次日期切换前状态，不访问云函数", async () => {
  const { page, calls } = fixture({ session: null });
  await page.refresh();
  const id = page.data.items[0]._id;
  await page.toggleItem({ currentTarget: { dataset: { id, index: 1 } }, detail: { value: true } });
  assert.equal(page.data.items[0].items[1].isDone, true);
  await page.load();
  assert.equal(page.data.items[0].items[1].isDone, true);
  assert.equal(calls.length, 0);
});

test("失败保留任务状态并解除提交锁，非法任务索引不能请求", async () => {
  const { page, errors } = fixture({ request: async (name, action) => {
    if (action === "toggleItem") throw new Error("Offline");
    return { items: [{ _id: "plan-1", items: [{ text: "原任务", isDone: false }] }] };
  } });
  await page.refresh();
  await page.toggleItem({ currentTarget: { dataset: { id: "plan-1", index: 0 } }, detail: { value: true } });
  assert.equal(page.data.items[0].items[0].isDone, false);
  assert.equal(page.data.toggleBusy, false);
  assert.equal(errors.length, 1);
  await page.toggleItem({ currentTarget: { dataset: { id: "plan-1", index: -1 } }, detail: { value: true } });
  assert.equal(errors.length, 1);
});

test("切换计划周期后旧响应不能覆盖最新结果", async () => {
  let finish;
  const first = new Promise((resolve) => { finish = resolve; });
  const { page } = fixture({ request: async (name, action, payload) => payload.type === "daily" ? first : { items: [{ _id: "weekly-result", items: [] }] } });
  const initial = page.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  await page.selectType({ currentTarget: { dataset: { value: "weekly" } } });
  finish({ items: [{ _id: "stale-result", items: [] }] });
  await initial;
  assert.equal(page.data.items[0]._id, "weekly-result");
});

test("计划行点击反转任务完成状态且支持撤销", async () => {
  const { page, calls } = fixture();
  await page.refresh();
  const event = { currentTarget: { dataset: { id: "plan-1", index: 0 } } };
  await page.toggleTask(event);
  assert.equal(page.data.items[0].items[0].isDone, true);
  assert.equal(calls.at(-1)[2].isDone, true);
  await page.toggleTask(event);
  assert.equal(page.data.items[0].items[0].isDone, false);
  assert.equal(calls.at(-1)[2].isDone, false);
  await page.toggleTask({ currentTarget: { dataset: { id: "plan-1", index: 99 } } });
  assert.equal(calls.length, 3);
});
