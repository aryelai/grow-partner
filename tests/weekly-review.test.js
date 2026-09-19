const test = require("node:test");
const assert = require("node:assert/strict");
const { getWeekRange, createWeeklyReview } = require("../miniprogram/utils/weekly-review");

test("每周复盘使用周一至周日且能跨月跨年", () => {
  assert.deepEqual(getWeekRange("2026-09-16"), { start: "2026-09-14", end: "2026-09-20" });
  assert.deepEqual(getWeekRange("2027-01-01"), { start: "2026-12-28", end: "2027-01-03" });
  assert.throws(() => getWeekRange("2026-02-29"), /日期/);
});

test("每周复盘只汇总客观完成数据和需要关注的学习状态", () => {
  const review = createWeeklyReview({
    today: "2026-09-16",
    homework: [
      { homeworkDate: "2026-09-14", isCompleted: false, learningState: "needs_help" },
      { homeworkDate: "2026-09-16", isCompleted: true, learningState: "corrected" },
      { homeworkDate: "2026-09-18", isCompleted: false, learningState: "" },
    ],
    notices: [
      { requirements: [{ isCompleted: true }, { isCompleted: false }] },
      { requirements: [] },
    ],
    plans: [
      { items: [{ isDone: true }, { isDone: false }] },
      { items: [{ isDone: true }] },
    ],
    habits: [
      { completedToday: true, streak: 6 },
      { completedToday: false, streak: 2 },
    ],
  });

  assert.deepEqual(review.homework, { total: 3, done: 1, overdue: 1, needsAttention: 1, percent: 33 });
  assert.deepEqual(review.noticeRequirements, { total: 2, done: 1, percent: 50 });
  assert.deepEqual(review.planTasks, { total: 3, done: 2, percent: 67 });
  assert.deepEqual(review.habits, { total: 2, doneToday: 1, longestStreak: 6, percent: 50 });
  assert.equal(review.rangeLabel, "9月14日—9月20日");
});

test("每周复盘忽略畸形记录且能标识分页不完整", () => {
  const review = createWeeklyReview({
    today: "2026-09-16",
    homework: [null, { homeworkDate: "bad", isCompleted: true }],
    notices: [{ requirements: "bad" }],
    plans: [{ items: null }],
    habits: [{ completedToday: "yes", streak: -1 }],
    incomplete: true,
  });
  assert.equal(review.homework.total, 0);
  assert.equal(review.noticeRequirements.total, 0);
  assert.equal(review.planTasks.total, 0);
  assert.equal(review.habits.doneToday, 0);
  assert.equal(review.incomplete, true);
});
