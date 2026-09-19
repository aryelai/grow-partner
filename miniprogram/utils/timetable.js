const WEEKDAYS = [
  { value: 1, label: "周一", shortLabel: "一" },
  { value: 2, label: "周二", shortLabel: "二" },
  { value: 3, label: "周三", shortLabel: "三" },
  { value: 4, label: "周四", shortLabel: "四" },
  { value: 5, label: "周五", shortLabel: "五" },
  { value: 6, label: "周六", shortLabel: "六" },
  { value: 7, label: "周日", shortLabel: "日" },
];
const PERIODS = Array.from({ length: 12 }, (_, index) => index + 1);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const UNCERTAIN_FIELDS = new Set(["dayOfWeek", "period", "courseName", "teacher", "location", "time"]);
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, maxLength) : "";
}

function normalizeTimeRange(candidate) {
  const startTime = cleanText(candidate && candidate.startTime, 5);
  const endTime = cleanText(candidate && candidate.endTime, 5);
  if (!startTime && !endTime) return { startTime: "", endTime: "" };
  if (!TIME_PATTERN.test(startTime) || !TIME_PATTERN.test(endTime) || startTime >= endTime) {
    return { startTime: "", endTime: "" };
  }
  return { startTime, endTime };
}

function normalizeTimetableEntries(value) {
  if (!Array.isArray(value)) return [];
  const entries = [];
  const positions = new Set();
  for (const candidate of value.slice(0, 84)) {
    if (!candidate || !Number.isSafeInteger(candidate.dayOfWeek) || candidate.dayOfWeek < 1 || candidate.dayOfWeek > 7
      || !Number.isSafeInteger(candidate.period) || candidate.period < 1 || candidate.period > 12) continue;
    const courseName = cleanText(candidate.courseName, 20);
    const position = `${candidate.dayOfWeek}:${candidate.period}`;
    if (!courseName || positions.has(position)) continue;
    positions.add(position);
    entries.push({
      dayOfWeek: candidate.dayOfWeek,
      period: candidate.period,
      courseName,
      teacher: cleanText(candidate.teacher, 20),
      location: cleanText(candidate.location, 30),
      ...normalizeTimeRange(candidate),
    });
  }
  return entries.sort((left, right) => left.dayOfWeek - right.dayOfWeek || left.period - right.period);
}

function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function normalizeTimetableOverrides(value) {
  if (!Array.isArray(value)) return [];
  const overrides = [];
  const positions = new Set();
  for (const candidate of value.slice(0, 180)) {
    if (!candidate || !isValidDate(candidate.date)
      || !Number.isSafeInteger(candidate.period) || candidate.period < 1 || candidate.period > 12) continue;
    const position = `${candidate.date}:${candidate.period}`;
    if (positions.has(position)) continue;
    const isCancelled = candidate.isCancelled === true;
    const courseName = isCancelled ? "" : cleanText(candidate.courseName, 20);
    if (!isCancelled && !courseName) continue;
    positions.add(position);
    overrides.push({
      date: candidate.date,
      period: candidate.period,
      isCancelled,
      courseName,
      teacher: isCancelled ? "" : cleanText(candidate.teacher, 20),
      location: isCancelled ? "" : cleanText(candidate.location, 30),
      ...(isCancelled ? { startTime: "", endTime: "" } : normalizeTimeRange(candidate)),
    });
  }
  return overrides.sort((left, right) => left.date.localeCompare(right.date) || left.period - right.period);
}

function createDaySlots(entries, dayOfWeek) {
  const normalized = normalizeTimetableEntries(entries);
  const byPeriod = new Map(normalized.filter((entry) => entry.dayOfWeek === dayOfWeek).map((entry) => [entry.period, entry]));
  return PERIODS.map((period) => {
    const entry = byPeriod.get(period) || null;
    return { period, entry, hasEntry: Boolean(entry) };
  });
}

function createDateSlots(entries, overrides, date) {
  if (!isValidDate(date)) return createDaySlots([], 1);
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay() || 7;
  const baseSlots = createDaySlots(entries, weekday);
  const byPeriod = new Map(normalizeTimetableOverrides(overrides)
    .filter((item) => item.date === date)
    .map((item) => [item.period, item]));
  return baseSlots.map((slot) => {
    const override = byPeriod.get(slot.period) || null;
    if (!override) return { ...slot, baseEntry: slot.entry, hasOverride: false, isCancelled: false };
    if (override.isCancelled) {
      return { ...slot, baseEntry: slot.entry, hasEntry: false, hasOverride: true, isCancelled: true, override };
    }
    const entry = {
      dayOfWeek: weekday,
      period: override.period,
      courseName: override.courseName,
      teacher: override.teacher,
      location: override.location,
      startTime: override.startTime,
      endTime: override.endTime,
    };
    return { ...slot, baseEntry: slot.entry, entry, hasEntry: true, hasOverride: true, isCancelled: false, override };
  });
}

function createEditableTimetableDrafts(entries, subjects, existingEntries, jobId) {
  const knownSubjects = new Set(Array.isArray(subjects) ? subjects : []);
  const existing = new Map(normalizeTimetableEntries(existingEntries)
    .map((entry) => [`${entry.dayOfWeek}:${entry.period}`, entry]));
  if (!Array.isArray(entries)) return [];
  const drafts = [];
  for (let index = 0; index < entries.length && drafts.length < 84; index += 1) {
    const candidate = entries[index];
    if (!candidate || !Number.isSafeInteger(candidate.dayOfWeek) || candidate.dayOfWeek < 1 || candidate.dayOfWeek > 7
      || !Number.isSafeInteger(candidate.period) || candidate.period < 1 || candidate.period > 12) continue;
    const courseName = cleanText(candidate.courseName, 20);
    if (!courseName) continue;
    const requestId = `${typeof jobId === "string" ? jobId.trim() : ""}_${index}`;
    if (!REQUEST_ID_PATTERN.test(requestId)) throw new Error("识别任务编号无效，请重新识别");
    const position = `${candidate.dayOfWeek}:${candidate.period}`;
    const oldEntry = existing.get(position);
    const uncertainFields = [...new Set(Array.isArray(candidate.uncertainFields)
      ? candidate.uncertainFields.filter((field) => typeof field === "string" && UNCERTAIN_FIELDS.has(field))
      : [])];
    const time = normalizeTimeRange(candidate);
    drafts.push({
      localId: `timetable-draft-${requestId}`,
      requestId,
      selected: true,
      dayOfWeek: candidate.dayOfWeek,
      dayIndex: candidate.dayOfWeek - 1,
      dayLabel: WEEKDAYS[candidate.dayOfWeek - 1].label,
      period: candidate.period,
      periodIndex: candidate.period - 1,
      courseName,
      teacher: cleanText(candidate.teacher, 20),
      location: cleanText(candidate.location, 30),
      startTime: time.startTime,
      endTime: time.endTime,
      hasTime: Boolean(time.startTime),
      uncertainFields,
      courseNameUncertain: uncertainFields.includes("courseName"),
      customCourse: !knownSubjects.has(courseName),
      teacherUncertain: uncertainFields.includes("teacher"),
      locationUncertain: uncertainFields.includes("location"),
      timeUncertain: uncertainFields.includes("time"),
      willReplace: Boolean(oldEntry),
      existingCourseName: oldEntry ? oldEntry.courseName : "",
    });
  }
  return drafts;
}

function createTimetableEntriesPayload(drafts) {
  const selected = Array.isArray(drafts) ? drafts.filter((draft) => draft && draft.selected !== false) : [];
  if (!selected.length) throw new Error("请至少选择一个课程格");
  const positions = new Set();
  return selected.map((draft) => {
    if (!Number.isSafeInteger(draft.dayOfWeek) || draft.dayOfWeek < 1 || draft.dayOfWeek > 7) throw new Error("请选择正确的星期");
    if (!Number.isSafeInteger(draft.period) || draft.period < 1 || draft.period > 12) throw new Error("请选择正确的节次");
    const courseName = cleanText(draft.courseName, 20);
    if (!courseName) throw new Error("请填写科目名称");
    const position = `${draft.dayOfWeek}:${draft.period}`;
    if (positions.has(position)) throw new Error("同一星期和节次只能有一门课程");
    positions.add(position);
    const startTime = cleanText(draft.startTime, 5);
    const endTime = cleanText(draft.endTime, 5);
    if (Boolean(startTime) !== Boolean(endTime)
      || (startTime && (!TIME_PATTERN.test(startTime) || !TIME_PATTERN.test(endTime) || startTime >= endTime))) {
      throw new Error("请填写正确的上课时间范围");
    }
    return {
      dayOfWeek: draft.dayOfWeek,
      period: draft.period,
      courseName,
      teacher: cleanText(draft.teacher, 20),
      location: cleanText(draft.location, 30),
      startTime,
      endTime,
    };
  });
}

module.exports = {
  WEEKDAYS,
  PERIODS,
  normalizeTimetableEntries,
  normalizeTimetableOverrides,
  createDaySlots,
  createDateSlots,
  createEditableTimetableDrafts,
  createTimetableEntriesPayload,
};
