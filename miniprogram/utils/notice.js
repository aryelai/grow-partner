const { NOTICE_CATEGORIES } = require("./constants");
const { formatDateTime } = require("./date");

function noticeTimeText(value) {
  if (!(value instanceof Date) && typeof value !== "string" && typeof value !== "number") return "";
  if (value === "" || value === 0 || (typeof value === "number" && !Number.isFinite(value))) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? formatDateTime(date) : "";
}

function normalizeRequirements(value) {
  return (Array.isArray(value) ? value : []).filter((item) => item && typeof item.id === "string" && typeof item.text === "string")
    .map((item) => ({ id: item.id, text: item.text.trim(), isCompleted: item.isCompleted === true }))
    .filter((item) => item.text);
}

function decorateNotice(item) {
  const deadlineText = noticeTimeText(item.deadline);
  const eventTimeText = noticeTimeText(item.eventTime);
  const remindTimeText = noticeTimeText(item.remindTime);
  const createdAtText = noticeTimeText(item.createdAt) || item.createdAtText || "";
  const candidates = [["截止", deadlineText], ["事项", eventTimeText], ["提醒", remindTimeText], ["发布", createdAtText]];
  const primary = candidates.find((entry) => entry[1]) || ["时间", "待补充"];
  const requirements = normalizeRequirements(item.requirements);
  return {
    ...item,
    isCompleted: item.isCompleted === true,
    categoryName: (NOTICE_CATEGORIES.find((category) => category.value === item.category) || {}).label || "其他",
    deadlineText, eventTimeText, remindTimeText, createdAtText,
    keyTimeLabel: primary[0], keyTimeText: primary[1],
    requirements,
    requirementCount: requirements.length,
    completedRequirementCount: requirements.filter((requirement) => requirement.isCompleted).length,
  };
}

function sortTime(value) {
  const timestamp = new Date(value || "").getTime();
  return Number.isNaN(timestamp) ? Number.POSITIVE_INFINITY : timestamp;
}

function sortNotices(items, now = new Date()) {
  const currentTime = now.getTime();
  return [...items].sort((left, right) => {
    if ((left.isCompleted === true) !== (right.isCompleted === true)) return left.isCompleted === true ? 1 : -1;
    const leftTime = Math.min(sortTime(left.deadline), sortTime(left.eventTime));
    const rightTime = Math.min(sortTime(right.deadline), sortTime(right.eventTime));
    const leftOverdue = Number.isFinite(leftTime) && leftTime < currentTime;
    const rightOverdue = Number.isFinite(rightTime) && rightTime < currentTime;
    if (leftOverdue !== rightOverdue) return leftOverdue ? -1 : 1;
    if (leftTime !== rightTime) return leftTime - rightTime;
    const leftCreatedAt = sortTime(left.createdAt);
    const rightCreatedAt = sortTime(right.createdAt);
    return (Number.isFinite(rightCreatedAt) ? rightCreatedAt : 0) - (Number.isFinite(leftCreatedAt) ? leftCreatedAt : 0);
  });
}

module.exports = { noticeTimeText, decorateNotice, normalizeRequirements, sortNotices };
