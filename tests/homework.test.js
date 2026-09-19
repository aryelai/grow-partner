const test = require("node:test");
const assert = require("node:assert/strict");

const { sortHomework } = require("../miniprogram/utils/homework");

test("未完成作业始终排在已完成作业之前", () => {
  const result = sortHomework([
    { _id: "done", isCompleted: true, createdAt: "2026-09-06T10:00:00.000Z" },
    { _id: "open", isCompleted: false, createdAt: "2026-09-05T10:00:00.000Z" },
  ], new Date("2026-09-06T00:00:00.000Z"));

  assert.deepEqual(result.map((item) => item._id), ["open", "done"]);
});

test("有效限时作业按截止时间升序排列", () => {
  const result = sortHomework([
    { _id: "later", isCompleted: false, hasDeadline: true, deadline: "2026-09-08T08:00:00.000Z" },
    { _id: "soon", isCompleted: false, hasDeadline: true, deadline: "2026-09-07T08:00:00.000Z" },
  ], new Date("2026-09-06T00:00:00.000Z"));

  assert.deepEqual(result.map((item) => item._id), ["soon", "later"]);
});

test("逾期未完成作业优先于未到期和无截止时间作业", () => {
  const result = sortHomework([
    { _id: "without-deadline", isCompleted: false, isImportant: true },
    { _id: "future", isCompleted: false, hasDeadline: true, deadline: "2026-09-20T08:00:00.000Z" },
    { _id: "overdue-later", isCompleted: false, hasDeadline: true, deadline: "2026-09-18T08:00:00.000Z" },
    { _id: "overdue-earlier", isCompleted: false, hasDeadline: true, deadline: "2026-09-17T08:00:00.000Z" },
  ], new Date("2026-09-19T00:00:00.000Z"));

  assert.deepEqual(result.map((item) => item._id), ["overdue-earlier", "overdue-later", "future", "without-deadline"]);
});

test("无有效截止时间时重要作业优先", () => {
  const result = sortHomework([
    { _id: "normal", isCompleted: false, isImportant: false, createdAt: "2026-09-06T12:00:00.000Z" },
    { _id: "important", isCompleted: false, isImportant: true, createdAt: "2026-09-05T12:00:00.000Z" },
  ], new Date("2026-09-06T00:00:00.000Z"));

  assert.deepEqual(result.map((item) => item._id), ["important", "normal"]);
});

test("同一日期的作业优先按照家庭科目顺序分组", () => {
  const result = sortHomework([
    { _id: "english-new", subject: "英语", isCompleted: false, createdAt: "2026-09-16T12:00:00.000Z" },
    { _id: "math", subject: "数学", isCompleted: false, createdAt: "2026-09-16T09:00:00.000Z" },
    { _id: "chinese", subject: "语文", isCompleted: false, createdAt: "2026-09-16T08:00:00.000Z" },
    { _id: "english-old", subject: "英语", isCompleted: false, createdAt: "2026-09-16T07:00:00.000Z" },
    { _id: "custom", subject: "班会", isCompleted: false, createdAt: "2026-09-16T13:00:00.000Z" },
  ], new Date("2026-09-16T00:00:00.000Z"), ["语文", "数学", "英语"]);

  assert.deepEqual(result.map((item) => item._id), ["chinese", "math", "english-new", "english-old", "custom"]);
});
