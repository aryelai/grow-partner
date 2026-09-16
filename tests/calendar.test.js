const test = require("node:test");
const assert = require("node:assert/strict");

test("月历按周一开头展示六周且正确标记今天和所选日期", () => {
  const { createMonthCalendar } = require("../miniprogram/utils/calendar");
  const calendar = createMonthCalendar("2026-09-16", "2026-09-14");
  assert.equal(calendar.label, "2026年9月");
  assert.equal(calendar.days.length, 42);
  assert.equal(calendar.days[0].value, "2026-08-31");
  assert.equal(calendar.days[0].inMonth, false);
  assert.equal(calendar.days.filter((day) => day.selected)[0].value, "2026-09-16");
  assert.equal(calendar.days.filter((day) => day.today)[0].value, "2026-09-14");
});

test("月历支持闰年与跨年换月并拒绝越界和非法方向", () => {
  const { createMonthCalendar, shiftCalendarMonth } = require("../miniprogram/utils/calendar");
  assert.ok(createMonthCalendar("2024-02-01", "2024-02-29").days.some((day) => day.value === "2024-02-29" && day.inMonth));
  assert.equal(shiftCalendarMonth("2026-12-31", 1), "2027-01-01");
  assert.equal(shiftCalendarMonth("2026-01-31", -1), "2025-12-01");
  assert.throws(() => shiftCalendarMonth("2026-02-30", 1));
  assert.throws(() => shiftCalendarMonth("2026-02-01", 2));
  assert.throws(() => shiftCalendarMonth("1900-01-01", -1));
  assert.throws(() => shiftCalendarMonth("2100-12-01", 1));
});
