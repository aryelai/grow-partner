const assert = require("node:assert/strict");
const test = require("node:test");
const { createListCompletion } = require("../miniprogram/utils/list-completion");
const { decorateNotice } = require("../miniprogram/utils/notice");
const { resetGuestCompletion } = require("../miniprogram/utils/guest-state");
const { createGuestHomeworkItems, createGuestNoticeItems } = require("../miniprogram/utils/guest-experience");

function fixture(options = {}) {
  const calls = [];
  const errors = [];
  const page = {
    currentUser: { role: options.role || "member" },
    data: { items: [{ _id: "item-1", isCompleted: false }], loading: false, completionBusy: false, guestMode: false },
    setData(values) { Object.assign(this.data, values); },
  };
  const controller = createListCompletion({
    kind: options.kind || "notice", permission: options.permission || "manageNotice",
    callFunction: options.request || (async (...args) => calls.push(args)),
    showError: (error) => errors.push(error),
    reload: options.reload || (async function () {}),
  });
  return { page, controller, calls, errors };
}

const event = { currentTarget: { dataset: { id: "item-1", completed: "false" } } };

test("卡片完成采用真实布尔状态，撤销恢复原值", async () => {
  const { page, controller, calls } = fixture();
  await controller.toggle.call(page, event);
  assert.deepEqual(calls[0], ["notice", "toggleCompleted", { id: "item-1", isCompleted: true }]);
  assert.equal(page.data.undoId, "item-1");
  await controller.undo.call(page);
  assert.equal(calls[1][2].isCompleted, false);
  assert.equal(page.data.undoId, "");
});

test("完成请求失败不伪造状态和撤销记录", async () => {
  const { page, controller, errors } = fixture({ request: async () => { throw new Error("Offline"); } });
  await controller.toggle.call(page, event);
  assert.equal(page.data.items[0].isCompleted, false);
  assert.equal(page.completionUndo, undefined);
  assert.equal(page.data.completionBusy, false);
  assert.equal(errors.length, 1);
});

test("重复点击只提交一次，孩子不能完成通知但能完成作业", async () => {
  let resolve;
  let count = 0;
  const pending = new Promise((done) => { resolve = done; });
  const { page, controller } = fixture({ request: async () => { count += 1; await pending; } });
  const first = controller.toggle.call(page, event);
  await controller.toggle.call(page, event);
  assert.equal(count, 1);
  resolve();
  await first;
  const child = fixture({ role: "child" });
  await child.controller.toggle.call(child.page, event);
  assert.equal(child.calls.length, 0);
  const homework = fixture({ role: "child", kind: "homework", permission: "toggleHomework" });
  await homework.controller.toggle.call(homework.page, event);
  assert.equal(homework.calls.length, 1);
});

test("游客完成先应用本地状态再筛选，首页和列表读取一致且可撤销", async () => {
  resetGuestCompletion();
  try {
    for (const kind of ["homework", "notice"]) {
      const read = kind === "homework" ? createGuestHomeworkItems : createGuestNoticeItems;
      const value = fixture({ kind, permission: kind === "homework" ? "toggleHomework" : "manageNotice" });
      value.page.data.guestMode = true;
      value.page.data.items = read({ status: "pending" });
      const id = value.page.data.items[0]._id;
      await value.controller.toggle.call(value.page, { currentTarget: { dataset: { id } } });
      assert.equal(read({ status: "pending" }).some((item) => item._id === id), false);
      assert.equal(read({ status: "completed" }).some((item) => item._id === id), true);
      assert.equal(value.calls.length, 0);
      await value.controller.undo.call(value.page);
      assert.equal(read({ status: "pending" }).some((item) => item._id === id), true);
    }
  } finally { resetGuestCompletion(); }
});

test("通知时间按截止、事项、提醒、发布降级，提醒已发送不是事项完成", () => {
  const item = { deadline: "2026-09-16T18:00:00+08:00", eventTime: "2026-09-17T09:00:00+08:00", reminderState: "completed", isReminded: true };
  assert.equal(decorateNotice(item).keyTimeLabel, "截止");
  assert.equal(decorateNotice(item).isCompleted, false);
  assert.equal(decorateNotice({ ...item, deadline: "invalid" }).keyTimeLabel, "事项");
  assert.equal(decorateNotice({ remindTime: "2026-09-15T12:00:00Z" }).keyTimeLabel, "提醒");
  assert.equal(decorateNotice({ createdAt: "2026-09-15T12:00:00Z" }).keyTimeLabel, "发布");
  for (const invalid of [null, false, {}, 0, NaN, "invalid"]) {
    assert.equal(decorateNotice({ deadline: invalid }).keyTimeText, "待补充");
  }
});
