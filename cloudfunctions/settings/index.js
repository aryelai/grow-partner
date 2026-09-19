const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const DEFAULT_SUBJECTS = {
  kindergarten: ["语言", "数学启蒙", "英语启蒙", "科学", "艺术", "体育", "社会"],
  primary: ["语文", "数学", "英语", "科学", "道德与法治", "音乐", "美术", "体育", "信息技术", "劳动"],
  junior_high: ["语文", "数学", "英语", "物理", "化学", "生物", "道德与法治", "历史", "地理", "音乐", "美术", "体育", "信息技术", "劳动技术"],
  senior_high: ["语文", "数学", "英语", "物理", "化学", "生物", "政治", "历史", "地理", "音乐", "美术", "体育", "通用技术", "信息技术"],
};
const VALID_PROVIDERS = new Set(["deepseek", "openai", "claude", "custom"]);
const MAX_RECOGNITION_GLOSSARY = 30;
const EXPORT_PAGE_SIZE = 50;
const EXPORT_MAX_ITEMS = 5000;
const EXPORT_DATASETS = Object.freeze({
  members: "users",
  homework: "homework",
  notices: "notices",
  habits: "habits",
  habit_checkins: "habit_checkins",
  habit_points: "habit_points",
  habit_rewards: "habit_rewards",
  plans: "plans",
  subjects: "subjects",
  timetables: "timetables",
  settings: "settings",
});
const EXPORT_OMITTED_KEYS = new Set([
  "openid", "creatorOpenid", "applicantOpenid", "recipientOpenid", "checkedByOpenid",
  "createdBy", "updatedBy", "phone", "inviteCode", "aiBaseUrl", "aiProvider", "aiModel",
  "accessToken", "refreshToken", "token", "apiKey", "secret", "password", "cookie", "authorization",
]);
const VALID_REMINDER_TARGETS = new Set([
  "father", "mother", "grandpa_paternal", "grandma_paternal",
  "grandpa_maternal", "grandma_maternal", "uncle_paternal",
  "aunt_paternal", "uncle_maternal", "aunt_maternal",
  "brother", "sister", "child",
]);

function success(data, message = "") { return { success: true, data, message }; }
function failure(message) { return { success: false, data: null, message }; }
function cleanText(value, maxLength) { return typeof value === "string" ? value.trim().slice(0, maxLength) : ""; }
function cleanReminderTargets(value, fallback = []) {
  if (!Array.isArray(value)) return fallback;
  return [...new Set(value.filter((item) => VALID_REMINDER_TARGETS.has(item)))];
}
function normalizeReminderDefaultAdvance(value) {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const advance = Number(value[0]);
  return Number.isInteger(advance) && [120, 1440].includes(advance) ? advance : null;
}

function cleanRecognitionGlossary(value) {
  if (!Array.isArray(value)) return [];
  const entries = [];
  const seen = new Set();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const term = cleanText(candidate.term, 20);
    const hint = cleanText(candidate.hint, 60);
    if (!term || seen.has(term)) continue;
    seen.add(term);
    entries.push({ term, hint });
    if (entries.length >= MAX_RECOGNITION_GLOSSARY) break;
  }
  return entries;
}

function validateRecognitionGlossary(value) {
  if (!Array.isArray(value) || value.length > MAX_RECOGNITION_GLOSSARY) return null;
  const entries = [];
  const seen = new Set();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
      || typeof candidate.term !== "string" || typeof candidate.hint !== "string") return null;
    const rawTerm = candidate.term.trim();
    const rawHint = candidate.hint.trim();
    if (!rawTerm || Array.from(rawTerm).length > 20 || Array.from(rawHint).length > 60) return null;
    const term = cleanText(rawTerm, 20);
    const hint = cleanText(rawHint, 60);
    if (!term || seen.has(term)) return null;
    seen.add(term);
    entries.push({ term, hint });
  }
  return entries;
}

async function requireUser(openid) {
  if (!openid) throw new Error("UNAUTHORIZED");
  const result = await db.collection("users").where({ openid }).limit(1).get();
  const user = result.data[0];
  if (!user || !user.familyId || !["creator", "member", "child"].includes(user.role)) throw new Error("UNAUTHORIZED");
  return user;
}

async function getFamily(user) {
  return (await db.collection("families").doc(user.familyId).get()).data;
}

async function getSettings(familyId) {
  const result = await db.collection("settings").where({ familyId }).limit(1).get();
  return result.data[0] || null;
}

function publicSettings(value) {
  const reminderAdvance = normalizeReminderDefaultAdvance(value && value.reminderDefaultAdvance);
  return {
    aiEnabled: value ? value.aiEnabled === true : false,
    aiProvider: value && VALID_PROVIDERS.has(value.aiProvider) ? value.aiProvider : "deepseek",
    aiBaseUrl: value ? value.aiBaseUrl || "" : "",
    aiModel: value ? value.aiModel || "" : "",
    aiKeyConfigured: false,
    reminderDefaultAdvance: reminderAdvance === null ? [120] : [reminderAdvance],
    reminderTargets: value && Array.isArray(value.reminderTargets) ? cleanReminderTargets(value.reminderTargets) : ["father", "mother"],
    allowMemberEditSettings: value ? value.allowMemberEditSettings === true : false,
    recognitionGlossary: cleanRecognitionGlossary(value && value.recognitionGlossary),
  };
}

function publicFamily(family, includeInviteCode) {
  const { creatorOpenid, inviteCode, ...safeFamily } = family;
  if (includeInviteCode && inviteCode) safeFamily.inviteCode = inviteCode;
  return safeFamily;
}

function sanitizeExportValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sanitizeExportValue);
  if (!value || typeof value !== "object") return value;
  const sanitized = {};
  for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) continue;
    if (EXPORT_OMITTED_KEYS.has(key) || /(?:openid|token|secret|password|cookie|authorization)/i.test(key)) continue;
    sanitized[key] = sanitizeExportValue(child);
  }
  return sanitized;
}

async function exportDataPage(user, event) {
  if (user.role !== "creator") return failure("只有家庭创建者可以导出家庭数据");
  const dataset = cleanText(event.dataset, 32);
  const collectionName = EXPORT_DATASETS[dataset];
  const offset = Number(event.offset);
  if (!collectionName || !Number.isSafeInteger(offset) || offset < 0 || offset > EXPORT_MAX_ITEMS) {
    return failure("导出参数不正确");
  }
  const collection = db.collection(collectionName).where({ familyId: user.familyId });
  const countResult = await collection.count();
  const pageResult = await db.collection(collectionName).where({ familyId: user.familyId })
    .skip(offset).limit(EXPORT_PAGE_SIZE).get();
  const total = Math.max(0, Number(countResult.total) || 0);
  const exportLimit = Math.min(total, EXPORT_MAX_ITEMS);
  const items = pageResult.data.map(sanitizeExportValue);
  const nextOffset = offset + items.length;
  const hasMore = nextOffset < exportLimit;
  return success({
    dataset,
    items,
    total,
    nextOffset,
    hasMore,
    truncated: total > EXPORT_MAX_ITEMS,
    maxItems: EXPORT_MAX_ITEMS,
    family: offset === 0 ? sanitizeExportValue(publicFamily(await getFamily(user), false)) : null,
    generatedAt: new Date().toISOString(),
  });
}

async function get(user) {
  const [family, settings] = await Promise.all([getFamily(user), getSettings(user.familyId)]);
  return success({ family: publicFamily(family, user.role === "creator"), settings: publicSettings(settings), currentRole: user.role });
}

async function updatePreferences(user, event) {
  const family = await getFamily(user);
  if (user.role !== "creator" && !(user.role === "member" && family.allowMemberEditSettings)) return failure("您没有修改设置的权限");
  const current = await getSettings(user.familyId);
  const currentPublic = publicSettings(current);
  const canManageAi = user.role === "creator";
  const provider = VALID_PROVIDERS.has(event.aiProvider) ? event.aiProvider : "deepseek";
  const requestedAdvance = event.reminderDefaultAdvance === undefined ? 120 : normalizeReminderDefaultAdvance(event.reminderDefaultAdvance);
  if (requestedAdvance === null) return failure("默认提醒时间只能选择一个");
  const reminderDefaultAdvance = [requestedAdvance];
  const reminderTargets = cleanReminderTargets(event.reminderTargets);
  const recognitionGlossary = event.recognitionGlossary === undefined
    ? currentPublic.recognitionGlossary
    : validateRecognitionGlossary(event.recognitionGlossary);
  if (recognitionGlossary === null) return failure("家庭识别词库格式不正确");
  const data = {
    familyId: user.familyId,
    aiEnabled: false,
    aiProvider: canManageAi ? provider : currentPublic.aiProvider,
    aiBaseUrl: canManageAi ? cleanText(event.aiBaseUrl, 300) : currentPublic.aiBaseUrl,
    aiModel: canManageAi ? cleanText(event.aiModel, 100) : currentPublic.aiModel,
    reminderDefaultAdvance,
    reminderTargets,
    recognitionGlossary,
    allowMemberEditSettings: user.role === "creator" ? event.allowMemberEditSettings === true : family.allowMemberEditSettings,
    updatedAt: new Date(),
  };
  if (current) await db.collection("settings").doc(current._id).update({ data });
  else await db.collection("settings").add({ data });
  if (user.role === "creator" && family.allowMemberEditSettings !== data.allowMemberEditSettings) {
    await db.collection("families").doc(user.familyId).update({ data: { allowMemberEditSettings: data.allowMemberEditSettings } });
  }
  return success(publicSettings(data), "设置已保存");
}

async function changeSemester(user, event) {
  if (user.role !== "creator") return failure("只有家庭创建者可以切换学期");
  const semester = cleanText(event.semester, 8);
  if (!/^\d{4}(上|下)$/.test(semester)) return failure("学期格式不正确");
  await db.collection("families").doc(user.familyId).update({ data: { currentSemester: semester } });
  return success({ semester }, "当前学期已切换");
}

async function updateFamily(user, event) {
  if (user.role !== "creator") return failure("只有家庭创建者可以修改孩子档案");
  const data = {};
  if (event.childName !== undefined) { const value = cleanText(event.childName, 20); if (!value) return failure("孩子姓名不能为空"); data.childName = value; }
  if (event.childNickname !== undefined) data.childNickname = cleanText(event.childNickname, 20);
  if (event.className !== undefined) data.className = cleanText(event.className, 30);
  if (!Object.keys(data).length) return failure("没有可更新的家庭信息");
  await db.collection("families").doc(user.familyId).update({ data });
  return success(data, "家庭信息已更新");
}

async function getSubjects(user) {
  const family = await getFamily(user);
  const result = await db.collection("subjects").where({ familyId: user.familyId, educationStage: family.educationStage, grade: family.grade }).limit(1).get();
  const record = result.data[0];
  const subjects = record ? record.subjects : DEFAULT_SUBJECTS[family.educationStage] || [];
  return success({ subjects, defaultSubjects: DEFAULT_SUBJECTS[family.educationStage] || [], customSubjects: record ? record.customSubjects || [] : [], canManageSubjects: user.role === "creator" || (user.role === "member" && family.allowMemberEditSettings === true) });
}

async function moveSubject(user, event) {
  const family = await getFamily(user);
  if (user.role !== "creator" && !(user.role === "member" && family.allowMemberEditSettings === true)) return failure("您没有管理科目的权限");
  if (![-1, 1].includes(event.offset)) return failure("科目移动方向不正确");
  const subject = cleanText(event.subject, 10);
  const defaults = DEFAULT_SUBJECTS[family.educationStage] || [];
  const result = await db.collection("subjects").where({ familyId: user.familyId, educationStage: family.educationStage, grade: family.grade }).limit(1).get();
  const record = result.data[0];
  const current = record && Array.isArray(record.subjects) ? record.subjects : defaults;
  const index = current.indexOf(subject);
  if (index < 0) return failure("科目不存在，请刷新后重试");
  const target = index + event.offset;
  if (target < 0 || target >= current.length) return failure("科目已在最前或最后");
  const subjects = current.slice();
  [subjects[index], subjects[target]] = [subjects[target], subjects[index]];
  const customSubjects = subjects.filter((item) => !defaults.includes(item));
  const order = Object.fromEntries(subjects.map((item, position) => [item, position]));
  const data = { familyId: user.familyId, educationStage: family.educationStage, grade: family.grade, subjects, customSubjects, order, updatedAt: new Date() };
  if (record) await db.collection("subjects").doc(record._id).update({ data });
  else await db.collection("subjects").add({ data });
  return success({ subjects, defaultSubjects: defaults, customSubjects }, "科目顺序已更新");
}

async function changeSubject(user, event, removing) {
  const family = await getFamily(user);
  if (user.role !== "creator" && !(user.role === "member" && family.allowMemberEditSettings)) return failure("您没有管理科目的权限");
  const subject = cleanText(event.subject, 10);
  if (!subject) return failure("科目名称不能为空");
  const defaults = DEFAULT_SUBJECTS[family.educationStage] || [];
  if (removing && defaults.includes(subject)) return failure("默认科目不能删除");
  const result = await db.collection("subjects").where({ familyId: user.familyId, educationStage: family.educationStage, grade: family.grade }).limit(1).get();
  const record = result.data[0];
  const current = record ? record.subjects || defaults : defaults;
  let subjects;
  if (removing) subjects = current.filter((item) => item !== subject);
  else subjects = current.includes(subject) ? current : [...current, subject];
  const customSubjects = subjects.filter((item) => !defaults.includes(item));
  const order = subjects.reduce((resultObject, item, index) => ({ ...resultObject, [item]: index }), {});
  const data = { familyId: user.familyId, educationStage: family.educationStage, grade: family.grade, subjects, customSubjects, order, updatedAt: new Date() };
  if (record) await db.collection("subjects").doc(record._id).update({ data }); else await db.collection("subjects").add({ data });
  return success({ subjects, defaultSubjects: defaults, customSubjects }, removing ? "自定义科目已删除" : "科目已添加");
}

async function renameSubject(user, event) {
  const family = await getFamily(user);
  if (user.role !== "creator" && !(user.role === "member" && family.allowMemberEditSettings)) {
    return failure("您没有管理科目的权限");
  }
  const subject = cleanText(event.subject, 10);
  const newSubject = cleanText(event.newSubject, 10);
  if (!subject || !newSubject) return failure("科目名称不能为空");
  const defaults = DEFAULT_SUBJECTS[family.educationStage] || [];
  const result = await db.collection("subjects").where({
    familyId: user.familyId,
    educationStage: family.educationStage,
    grade: family.grade,
  }).limit(1).get();
  const record = result.data[0];
  const current = record && Array.isArray(record.subjects) ? record.subjects : defaults;
  if (!current.includes(subject)) return failure("原科目不存在，请刷新后重试");
  if (newSubject !== subject && current.includes(newSubject)) return failure("该科目名称已存在");
  if (newSubject === subject) {
    return success({
      subjects: current,
      defaultSubjects: defaults,
      customSubjects: current.filter((item) => !defaults.includes(item)),
    });
  }
  const subjects = current.map((item) => item === subject ? newSubject : item);
  const customSubjects = subjects.filter((item) => !defaults.includes(item));
  const order = subjects.reduce((resultObject, item, index) => ({ ...resultObject, [item]: index }), {});
  const data = {
    familyId: user.familyId,
    educationStage: family.educationStage,
    grade: family.grade,
    subjects,
    customSubjects,
    order,
    updatedAt: new Date(),
  };
  if (record) await db.collection("subjects").doc(record._id).update({ data });
  else await db.collection("subjects").add({ data });
  return success({ subjects, defaultSubjects: defaults, customSubjects }, "科目名称已修改");
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  try {
    const user = await requireUser(OPENID);
    switch (event.action) {
      case "get": return await get(user);
      case "updatePreferences": return await updatePreferences(user, event);
      case "changeSemester": return await changeSemester(user, event);
      case "updateFamily": return await updateFamily(user, event);
      case "getSubjects": return await getSubjects(user);
      case "addSubject": return await changeSubject(user, event, false);
      case "removeSubject": return await changeSubject(user, event, true);
      case "renameSubject": return await renameSubject(user, event);
      case "moveSubject": return await moveSubject(user, event);
      case "exportDataPage": return await exportDataPage(user, event);
      default: return failure("不支持的操作");
    }
  } catch (error) {
    console.error("Settings action failed", { action: event.action, message: error.message, stack: error.stack });
    return failure(error.message === "UNAUTHORIZED" ? "请先登录并加入家庭" : "设置服务暂时不可用，请稍后重试");
  }
};
