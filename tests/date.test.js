const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getCurrentSemester,
  getAdjacentSemester,
  getDateRangeForPlan,
  getBeijingDate,
  formatHomeworkDate,
} = require("../miniprogram/utils/date");

test("一月归属上一自然年的下学期", () => {
  assert.equal(getCurrentSemester(new Date(2027, 0, 15)), "2026下");
});

test("作业默认日期使用北京时间且展示星期不受设备时区影响", () => {
  assert.equal(getBeijingDate(new Date("2026-09-14T16:00:00.000Z")), "2026-09-15");
  assert.equal(formatHomeworkDate("2026-09-15"), "2026-09-15 周二");
  assert.equal(formatHomeworkDate("2024-02-29"), "2024-02-29 周四");
  for (const value of [undefined, "", "2026-02-29", "2026-09-31", "2026-9-15"]) {
    assert.equal(formatHomeworkDate(value), "日期待补充");
  }
});

test("二月至七月归属当年上学期", () => {
  assert.equal(getCurrentSemester(new Date(2027, 6, 31)), "2027上");
});

test("相邻学期跨年切换正确", () => {
  assert.equal(getAdjacentSemester("2026下", 1), "2027上");
  assert.equal(getAdjacentSemester("2026上", -1), "2025下");
});

test("周计划范围从周一开始并在周日结束", () => {
  assert.deepEqual(getDateRangeForPlan("weekly", "2026-09-06"), {
    start: "2026-08-31",
    end: "2026-09-06",
  });
});
