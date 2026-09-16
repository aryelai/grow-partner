const { NOTICE_CATEGORIES } = require("./constants");
const { formatDateTime } = require("./date");

const MAX_DRAFTS = 20;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const UNCERTAIN_FIELDS = new Set(["title", "source", "category", "content", "eventTime"]);
const CATEGORY_LABELS = new Map(NOTICE_CATEGORIES.map((item) => [item.value, item.label]));

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeSuggestedTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function createEditableNoticeDrafts(drafts, semester, jobId) {
  if (!Array.isArray(drafts)) return [];
  return drafts.slice(0, MAX_DRAFTS).map((draft, index) => {
    const requestId = `${typeof jobId === "string" ? jobId.trim() : ""}_${index}`;
    if (!REQUEST_ID_PATTERN.test(requestId)) throw new Error("识别任务编号无效，请重新识别");
    const rawCategory = cleanText(draft && draft.category, 32);
    const category = CATEGORY_LABELS.has(rawCategory) ? rawCategory : "other";
    const suggestedRemindTime = normalizeSuggestedTime(draft && draft.suggestedRemindTime);
    const uncertainFields = [...new Set(Array.isArray(draft && draft.uncertainFields)
      ? draft.uncertainFields.filter((field) => typeof field === "string" && UNCERTAIN_FIELDS.has(field))
      : [])];
    return {
      localId: `notice-draft-${requestId}`,
      requestId,
      saved: false,
      semester: /^\d{4}(上|下)$/.test(String(draft && draft.semester)) ? draft.semester : semester,
      title: cleanText(draft && draft.title, 80),
      source: cleanText(draft && draft.source, 60),
      category,
      categoryLabel: CATEGORY_LABELS.get(category),
      content: cleanText(draft && draft.content, 3000),
      suggestedRemindTime,
      suggestedRemindTimeText: suggestedRemindTime ? formatDateTime(suggestedRemindTime) : "",
      uncertainFields,
      titleUncertain: uncertainFields.includes("title"),
      sourceUncertain: uncertainFields.includes("source"),
      categoryUncertain: uncertainFields.includes("category"),
      contentUncertain: uncertainFields.includes("content"),
      eventTimeUncertain: uncertainFields.includes("eventTime"),
    };
  });
}

function createNoticeDraftTransfer(draft) {
  const requestId = typeof (draft && draft.requestId) === "string" ? draft.requestId.trim() : "";
  const semester = cleanText(draft && draft.semester, 8);
  const title = cleanText(draft && draft.title, 80);
  const rawCategory = cleanText(draft && draft.category, 32);
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new Error("识别草稿编号无效，请重新识别");
  if (!/^\d{4}(上|下)$/.test(semester) || !title) throw new Error("请填写通知标题");
  return {
    requestId,
    semester,
    title,
    source: cleanText(draft && draft.source, 60),
    category: CATEGORY_LABELS.has(rawCategory) ? rawCategory : "other",
    content: cleanText(draft && draft.content, 3000),
    suggestedRemindTime: normalizeSuggestedTime(draft && draft.suggestedRemindTime),
  };
}

function stripListMarker(value) {
  return cleanText(value, 80).replace(/^\s*(?:\d+[.、)）]|[-•])\s*/, "");
}

function mergeNoticeDrafts(drafts, jobId) {
  if (!Array.isArray(drafts) || drafts.length < 2) return Array.isArray(drafts) ? drafts : [];
  const requestId = `${typeof jobId === "string" ? jobId.trim() : ""}_merged`;
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new Error("识别任务编号无效，请重新识别");
  const validDrafts = drafts.filter((draft) => draft && !draft.saved && cleanText(draft.title, 80));
  if (validDrafts.length < 2) return validDrafts;
  const sources = [...new Set(validDrafts.map((draft) => cleanText(draft.source, 60)).filter(Boolean))];
  const categories = [...new Set(validDrafts.map((draft) => cleanText(draft.category, 32)).filter((value) => CATEGORY_LABELS.has(value)))];
  const suggestedTimes = [...new Set(validDrafts.map((draft) => normalizeSuggestedTime(draft.suggestedRemindTime)).filter(Boolean))];
  const uncertainFields = new Set(validDrafts.flatMap((draft) => Array.isArray(draft.uncertainFields) ? draft.uncertainFields : []));
  uncertainFields.add("title");
  if (suggestedTimes.length > 1) uncertainFields.add("eventTime");
  const fullContent = validDrafts.map((draft, index) => {
    const title = stripListMarker(draft.title) || `第 ${index + 1} 项`;
    const detail = cleanText(draft.content, 3000);
    return `${index + 1}. ${title}${detail ? `\n${detail}` : ""}`;
  }).join("\n\n");
  if (fullContent.length > 3000) uncertainFields.add("content");
  const content = fullContent.slice(0, 3000);
  const category = categories.length === 1 ? categories[0] : "other";
  const normalizedUncertainFields = [...uncertainFields].filter((field) => UNCERTAIN_FIELDS.has(field));
  return [{
    localId: `notice-draft-${requestId}`,
    requestId,
    saved: false,
    semester: cleanText(validDrafts[0].semester, 8),
    title: "学校通知",
    source: sources.length === 1 ? sources[0] : "",
    category,
    categoryLabel: CATEGORY_LABELS.get(category),
    content,
    suggestedRemindTime: suggestedTimes.length === 1 ? suggestedTimes[0] : "",
    suggestedRemindTimeText: suggestedTimes.length === 1 ? formatDateTime(suggestedTimes[0]) : "",
    uncertainFields: normalizedUncertainFields,
    titleUncertain: true,
    sourceUncertain: uncertainFields.has("source") || sources.length > 1,
    categoryUncertain: uncertainFields.has("category") || categories.length > 1,
    contentUncertain: uncertainFields.has("content"),
    eventTimeUncertain: uncertainFields.has("eventTime") || suggestedTimes.length > 1,
  }];
}

function createNoticeBatchPayload(drafts) {
  if (!Array.isArray(drafts)) throw new Error("通知草稿格式不正确");
  return drafts.filter((draft) => draft && !draft.saved).map((draft) => {
    const transfer = createNoticeDraftTransfer(draft);
    return {
      semester: transfer.semester,
      title: transfer.title,
      source: transfer.source,
      category: transfer.category,
      content: transfer.content,
      images: [],
      remindTime: null,
      remindAdvance: [120],
      remindTargets: [],
      clientRequestId: transfer.requestId,
    };
  });
}

module.exports = {
  MAX_DRAFTS,
  createEditableNoticeDrafts,
  createNoticeDraftTransfer,
  createNoticeBatchPayload,
  mergeNoticeDrafts,
};
