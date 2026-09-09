const crypto = require("crypto");

const TODO_TEMPLATE_ID = "5Iy1Jv7aswWNmrRMDXgrcj2BKeywdH6evDst6OomB2c";
const CATEGORY_NAMES = {
  flag_raising: "学校通知",
  exam: "考试通知",
  activity: "活动安排",
  homework: "作业事项",
  other: "其他事项",
};
const ERROR_CATEGORIES = new Map([
  [43101, "authorization_missing"],
  [43107, "blocked"],
  [43108, "concurrent"],
  [47003, "invalid_payload"],
  [45168, "sensitive"],
]);
const THING_MAX_CODE_POINTS = 20;

function hashParts(parts) {
  return crypto.createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

function createSubscriptionId(openid, templateId) {
  return hashParts([openid, templateId]);
}

function createDeliveryId(noticeId, reminderVersion, recipientOpenid, templateId) {
  return hashParts([noticeId, String(reminderVersion), recipientOpenid, templateId]);
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\p{Cc}/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function truncateThing(value) {
  return Array.from(normalizeText(value)).slice(0, THING_MAX_CODE_POINTS).join("");
}

function getBeijingTime(remindTime) {
  if (!(remindTime instanceof Date) || Number.isNaN(remindTime.getTime())) {
    throw new Error("INVALID_REMIND_TIME");
  }

  return new Date(remindTime.getTime() + 8 * 60 * 60 * 1000);
}

function formatTemplateTime(remindTime) {
  const beijingTime = getBeijingTime(remindTime);
  const month = String(beijingTime.getUTCMonth() + 1).padStart(2, "0");
  const day = String(beijingTime.getUTCDate()).padStart(2, "0");
  const hour = String(beijingTime.getUTCHours()).padStart(2, "0");
  const minute = String(beijingTime.getUTCMinutes()).padStart(2, "0");

  return { date: `${month}月${day}日`, time: `${hour}:${minute}` };
}

function buildTemplateData(notice) {
  const formattedTime = formatTemplateTime(notice && notice.remindTime);
  const category = CATEGORY_NAMES[notice && notice.category] || CATEGORY_NAMES.other;

  return {
    thing1: { value: truncateThing(notice && notice.title) },
    time2: { value: formattedTime.time },
    thing4: { value: truncateThing(`${formattedTime.date}·${normalizeText(notice && notice.content)}`) },
    thing15: { value: truncateThing(category) },
    phrase25: { value: "待处理" },
  };
}

function buildSafeTemplateData(notice) {
  const formattedTime = formatTemplateTime(notice && notice.remindTime);

  return {
    thing1: { value: "家庭待办" },
    time2: { value: formattedTime.time },
    thing4: { value: truncateThing(`${formattedTime.date}·请进入小程序查看详情`) },
    thing15: { value: "其他事项" },
    phrase25: { value: "待处理" },
  };
}

function classifySendError(error) {
  const errCode = error && typeof error === "object" ? error.errCode : undefined;
  const category = ERROR_CATEGORIES.get(errCode);
  if (category) return category;
  if (errCode === -1) return "temporary";

  const message = error && typeof error === "object"
    ? typeof error.errMsg === "string"
      ? error.errMsg
      : error.message
    : "";
  return typeof message === "string" && /\bsystem busy\b/i.test(message)
    ? "temporary"
    : "uncertain";
}

module.exports = {
  TODO_TEMPLATE_ID,
  createSubscriptionId,
  createDeliveryId,
  buildTemplateData,
  buildSafeTemplateData,
  classifySendError,
};
