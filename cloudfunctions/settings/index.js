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
  return {
    aiEnabled: value ? value.aiEnabled === true : false,
    aiProvider: value && VALID_PROVIDERS.has(value.aiProvider) ? value.aiProvider : "deepseek",
    aiBaseUrl: value ? value.aiBaseUrl || "" : "",
    aiModel: value ? value.aiModel || "" : "",
    aiKeyConfigured: false,
    reminderDefaultAdvance: value && Array.isArray(value.reminderDefaultAdvance) ? value.reminderDefaultAdvance : [1440, 120],
    reminderTargets: value && Array.isArray(value.reminderTargets) ? cleanReminderTargets(value.reminderTargets) : ["father", "mother"],
    allowMemberEditSettings: value ? value.allowMemberEditSettings === true : false,
  };
}

function publicFamily(family, includeInviteCode) {
  const { creatorOpenid, inviteCode, ...safeFamily } = family;
  if (includeInviteCode && inviteCode) safeFamily.inviteCode = inviteCode;
  return safeFamily;
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
  const reminderDefaultAdvance = Array.isArray(event.reminderDefaultAdvance) ? [...new Set(event.reminderDefaultAdvance.map(Number).filter((value) => [1440, 120].includes(value)))] : [1440, 120];
  const reminderTargets = cleanReminderTargets(event.reminderTargets);
  const data = {
    familyId: user.familyId,
    aiEnabled: false,
    aiProvider: canManageAi ? provider : currentPublic.aiProvider,
    aiBaseUrl: canManageAi ? cleanText(event.aiBaseUrl, 300) : currentPublic.aiBaseUrl,
    aiModel: canManageAi ? cleanText(event.aiModel, 100) : currentPublic.aiModel,
    reminderDefaultAdvance,
    reminderTargets,
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
  return success({ subjects, defaultSubjects: DEFAULT_SUBJECTS[family.educationStage] || [], customSubjects: record ? record.customSubjects || [] : [] });
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
      default: return failure("不支持的操作");
    }
  } catch (error) {
    console.error("Settings action failed", { action: event.action, message: error.message, stack: error.stack });
    return failure(error.message === "UNAUTHORIZED" ? "请先登录并加入家庭" : "设置服务暂时不可用，请稍后重试");
  }
};
