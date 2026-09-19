const crypto = require("node:crypto");

const MAX_ENTRIES = 84;
const MAX_OVERRIDES = 180;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  return Array.from(value.replace(/\p{Cc}/gu, "").trim()).slice(0, maxLength).join("");
}

function validateSemester(value) {
  const semester = cleanText(value, 8);
  if (!/^\d{4}(上|下)$/.test(semester)) throw new Error("INVALID_SEMESTER");
  return semester;
}

function normalizeEntry(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("INVALID_ENTRY");
  const dayOfWeek = candidate.dayOfWeek;
  const period = candidate.period;
  if (!Number.isSafeInteger(dayOfWeek) || dayOfWeek < 1 || dayOfWeek > 7) throw new Error("INVALID_DAY");
  if (!Number.isSafeInteger(period) || period < 1 || period > 12) throw new Error("INVALID_PERIOD");
  const courseName = cleanText(candidate.courseName, 20);
  if (!courseName) throw new Error("INVALID_COURSE_NAME");
  const startTime = cleanText(candidate.startTime, 5);
  const endTime = cleanText(candidate.endTime, 5);
  if (Boolean(startTime) !== Boolean(endTime)
    || (startTime && (!TIME_PATTERN.test(startTime) || !TIME_PATTERN.test(endTime) || startTime >= endTime))) {
    throw new Error("INVALID_TIME_RANGE");
  }
  return {
    dayOfWeek,
    period,
    courseName,
    teacher: cleanText(candidate.teacher, 20),
    location: cleanText(candidate.location, 30),
    startTime,
    endTime,
  };
}

function normalizeEntries(value) {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) throw new Error("INVALID_ENTRIES");
  const entries = [];
  const positions = new Set();
  for (const candidate of value) {
    const entry = normalizeEntry(candidate);
    const position = `${entry.dayOfWeek}:${entry.period}`;
    if (positions.has(position)) throw new Error("DUPLICATE_ENTRY");
    positions.add(position);
    entries.push(entry);
  }
  return entries.sort((left, right) => left.dayOfWeek - right.dayOfWeek || left.period - right.period);
}

function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function normalizeOverride(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("INVALID_OVERRIDE");
  const date = cleanText(candidate.date, 10);
  if (!isValidDate(date)) throw new Error("INVALID_OVERRIDE_DATE");
  const period = candidate.period;
  if (!Number.isSafeInteger(period) || period < 1 || period > 12) throw new Error("INVALID_PERIOD");
  const isCancelled = candidate.isCancelled === true;
  if (isCancelled) {
    return { date, period, isCancelled: true, courseName: "", teacher: "", location: "", startTime: "", endTime: "" };
  }
  const entry = normalizeEntry({ ...candidate, dayOfWeek: 1 });
  return {
    date,
    period,
    isCancelled: false,
    courseName: entry.courseName,
    teacher: entry.teacher,
    location: entry.location,
    startTime: entry.startTime,
    endTime: entry.endTime,
  };
}

function normalizeOverrides(value) {
  if (!Array.isArray(value) || value.length > MAX_OVERRIDES) throw new Error("INVALID_OVERRIDES");
  const overrides = [];
  const positions = new Set();
  for (const candidate of value) {
    const override = normalizeOverride(candidate);
    const position = `${override.date}:${override.period}`;
    if (positions.has(position)) throw new Error("DUPLICATE_OVERRIDE");
    positions.add(position);
    overrides.push(override);
  }
  return overrides.sort((left, right) => left.date.localeCompare(right.date) || left.period - right.period);
}

function validateExpectedVersion(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("INVALID_VERSION");
  return value;
}

function buildTimetableId(familyId, semester) {
  if (typeof familyId !== "string" || !familyId) throw new Error("INVALID_FAMILY");
  return crypto.createHash("sha256").update(["timetable", familyId, validateSemester(semester)].join("\u0000")).digest("hex");
}

function mergeTimetableEntries(currentValue, incomingValue) {
  const current = normalizeEntries(currentValue);
  const incoming = normalizeEntries(incomingValue);
  const entriesByPosition = new Map(current.map((entry) => [`${entry.dayOfWeek}:${entry.period}`, entry]));
  let addedCount = 0;
  let replacedCount = 0;
  for (const entry of incoming) {
    const position = `${entry.dayOfWeek}:${entry.period}`;
    if (entriesByPosition.has(position)) replacedCount += 1;
    else addedCount += 1;
    entriesByPosition.set(position, entry);
  }
  return { entries: normalizeEntries([...entriesByPosition.values()]), addedCount, replacedCount };
}

module.exports = {
  MAX_ENTRIES,
  MAX_OVERRIDES,
  validateSemester,
  normalizeEntry,
  normalizeEntries,
  normalizeOverride,
  normalizeOverrides,
  validateExpectedVersion,
  buildTimetableId,
  mergeTimetableEntries,
};
