const test = require("node:test");
const assert = require("node:assert/strict");

const {
  WEEKDAYS,
  PERIODS,
  normalizeTimetableEntries,
  createDaySlots,
  normalizeTimetableOverrides,
  createDateSlots,
  createEditableTimetableDrafts,
  createTimetableEntriesPayload,
} = require("../miniprogram/utils/timetable");

const TEST_JOB_ID = "01010101010101010101010101010101";

test("课程表客户端提供周一至周日和十二节完整视图", () => {
  assert.equal(WEEKDAYS.length, 7);
  assert.equal(PERIODS.length, 12);
  const slots = createDaySlots([{ dayOfWeek: 1, period: 2, courseName: "数学" }], 1);
  assert.equal(slots.length, 12);
  assert.equal(slots[0].hasEntry, false);
  assert.equal(slots[1].entry.courseName, "数学");
});

test("课程表客户端忽略畸形和重复服务端记录", () => {
  const entries = normalizeTimetableEntries([
    { dayOfWeek: 1, period: 1, courseName: "语文", teacher: "李老师" },
    { dayOfWeek: 1, period: 1, courseName: "数学" },
    { dayOfWeek: 8, period: 1, courseName: "英语" },
    { dayOfWeek: 2, period: 2, courseName: "" },
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].courseName, "语文");
  assert.equal(entries[0].startTime, "");
});

test("指定日期课程用临时调课覆盖周课程并清楚标识停课", () => {
  const entries = [
    { dayOfWeek: 5, period: 1, courseName: "语文" },
    { dayOfWeek: 5, period: 2, courseName: "数学" },
  ];
  const overrides = normalizeTimetableOverrides([
    { date: "2026-09-18", period: 1, isCancelled: false, courseName: "班会" },
    { date: "2026-09-18", period: 2, isCancelled: true },
    { date: "bad", period: 3, isCancelled: true },
  ]);
  const slots = createDateSlots(entries, overrides, "2026-09-18");
  assert.equal(slots[0].entry.courseName, "班会");
  assert.equal(slots[0].hasOverride, true);
  assert.equal(slots[1].entry.courseName, "数学");
  assert.equal(slots[1].isCancelled, true);
  assert.equal(slots[1].hasEntry, false);
  assert.equal(slots[2].hasEntry, false);
});

test("课程表 AI 草稿标记既有课程冲突并生成安全批量载荷", () => {
  const drafts = createEditableTimetableDrafts([{
    dayOfWeek: 1,
    period: 1,
    courseName: "语文",
    teacher: "李老师",
    location: "101",
    startTime: "08:00",
    endTime: "08:40",
    uncertainFields: ["courseName", "createdBy"],
  }], ["语文"], [{ dayOfWeek: 1, period: 1, courseName: "数学" }], TEST_JOB_ID);

  assert.equal(drafts[0].requestId, `${TEST_JOB_ID}_0`);
  assert.equal(drafts[0].willReplace, true);
  assert.equal(drafts[0].existingCourseName, "数学");
  assert.equal(drafts[0].dayLabel, "周一");
  assert.equal(drafts[0].courseNameUncertain, true);
  assert.deepEqual(createTimetableEntriesPayload(drafts), [{
    dayOfWeek: 1,
    period: 1,
    courseName: "语文",
    teacher: "李老师",
    location: "101",
    startTime: "08:00",
    endTime: "08:40",
  }]);
});

test("课程表批量载荷拒绝空选择、重复位置和不完整时间", () => {
  assert.throws(() => createTimetableEntriesPayload([]), /至少选择/);
  const base = {
    selected: true,
    dayOfWeek: 1,
    period: 1,
    courseName: "语文",
    teacher: "",
    location: "",
    startTime: "",
    endTime: "",
  };
  assert.throws(() => createTimetableEntriesPayload([base, { ...base, courseName: "数学" }]), /同一星期和节次/);
  assert.throws(() => createTimetableEntriesPayload([{ ...base, startTime: "08:00" }]), /上课时间/);
});
