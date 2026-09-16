const { NOTICE_CATEGORIES } = require("./constants");
const { formatDateTime } = require("./date");

function noticeTimeText(value) {
  if (!(value instanceof Date) && typeof value !== "string" && typeof value !== "number") return "";
  if (value === "" || value === 0 || (typeof value === "number" && !Number.isFinite(value))) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? formatDateTime(date) : "";
}

function decorateNotice(item) {
  const deadlineText = noticeTimeText(item.deadline);
  const eventTimeText = noticeTimeText(item.eventTime);
  const remindTimeText = noticeTimeText(item.remindTime);
  const createdAtText = noticeTimeText(item.createdAt) || item.createdAtText || "";
  const candidates = [["截止", deadlineText], ["事项", eventTimeText], ["提醒", remindTimeText], ["发布", createdAtText]];
  const primary = candidates.find((entry) => entry[1]) || ["时间", "待补充"];
  return {
    ...item,
    isCompleted: item.isCompleted === true,
    categoryName: (NOTICE_CATEGORIES.find((category) => category.value === item.category) || {}).label || "其他",
    deadlineText, eventTimeText, remindTimeText, createdAtText,
    keyTimeLabel: primary[0], keyTimeText: primary[1],
  };
}

module.exports = { noticeTimeText, decorateNotice };
