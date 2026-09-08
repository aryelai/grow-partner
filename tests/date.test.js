const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getCurrentSemester,
  getAdjacentSemester,
  getDateRangeForPlan,
} = require("../miniprogram/utils/date");

test("一月归属上一自然年的下学期", () => {
  assert.equal(getCurrentSemester(new Date(2027, 0, 15)), "2026下");
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
