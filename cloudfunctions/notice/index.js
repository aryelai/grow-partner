const cloud = require("wx-server-sdk");
const { normalizeAdvance, buildReminderFields } = require("./reminder-policy");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const VALID_CATEGORIES = new Set(["flag_raising", "exam", "activity", "homework", "other"]);
const VALID_REMINDER_TARGETS = new Set([
  "father", "mother", "grandpa_paternal", "grandma_paternal",
  "grandpa_maternal", "grandma_maternal", "uncle_paternal",
  "aunt_paternal", "uncle_maternal", "aunt_maternal",
  "brother", "sister", "child",
]);
const RELATION_NAMES = { father: "爸爸", mother: "妈妈", grandpa_paternal: "爷爷", grandma_paternal: "奶奶", grandpa_maternal: "外公", grandma_maternal: "外婆", uncle_paternal: "叔叔", aunt_paternal: "婶婶", uncle_maternal: "舅舅", aunt_maternal: "舅妈", brother: "哥哥", sister: "姐姐", child: "孩子" };

function success(data, message = "") { return { success: true, data, message }; }
function failure(message) { return { success: false, data: null, message }; }
function cleanText(value, maxLength) { return typeof value === "string" ? value.trim().slice(0, maxLength) : ""; }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function publicNotice(value) {
  const { createdBy, ...safeValue } = value;
  return safeValue;
}

async function requireUser(openid) {
  if (!openid) throw new Error("UNAUTHORIZED");
  const result = await db.collection("users").where({ openid }).limit(1).get();
  const user = result.data[0];
  if (!user || !user.familyId || !["creator", "member", "child"].includes(user.role)) throw new Error("UNAUTHORIZED");
  return user;
}

async function findNotice(id, familyId, database = db) {
  try {
    const item = (await database.collection("notices").doc(id).get()).data;
    return item && item.familyId === familyId ? item : null;
  } catch (error) {
    if (/document.*(?:does not exist|not found)/i.test(String(error.errMsg || error.message))) return null;
    throw error;
  }
}

function validatePayload(event) {
  const title = cleanText(event.title, 80);
  const semester = cleanText(event.semester, 8);
  const category = cleanText(event.category, 32);
  const images = Array.isArray(event.images) ? event.images.slice(0, 9) : [];
  const remindAdvance = normalizeAdvance(event.remindAdvance);
  const remindTargets = Array.isArray(event.remindTargets)
    ? [...new Set(event.remindTargets.filter((value) => VALID_REMINDER_TARGETS.has(value)))]
    : [];
  const remindTime = event.remindTime ? new Date(event.remindTime) : null;
  if (!title || !/^\d{4}(上|下)$/.test(semester) || !VALID_CATEGORIES.has(category)) return { error: "请完整填写标题、学期和分类" };
  if (images.some((item) => typeof item !== "string" || !item.startsWith("cloud://"))) return { error: "图片地址格式不正确" };
  if (remindTime && Number.isNaN(remindTime.getTime())) return { error: "提醒时间格式不正确" };
  if (remindTime && remindAdvance === null) return { error: "每条通知只能选择一个提醒时间" };
  return { data: { semester, title, content: cleanText(event.content, 3000), images, source: cleanText(event.source, 60), category, remindTime, remindAdvance: remindAdvance === null ? [] : [remindAdvance], remindTargets } };
}

async function list(user, event) {
  const page = Math.max(1, Number.parseInt(event.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, Number.parseInt(event.pageSize, 10) || 20));
  const query = { familyId: user.familyId };
  const semester = cleanText(event.semester, 8);
  if (semester) query.semester = semester;
  const category = cleanText(event.category, 32);
  if (category && category !== "all") query.category = category;
  const keyword = cleanText(event.keyword, 50);
  if (keyword) query.title = db.RegExp({ regexp: escapeRegExp(keyword), options: "i" });
  const collection = db.collection("notices").where(query);
  const [countResult, dataResult] = await Promise.all([
    collection.count(),
    collection.orderBy("createdAt", "desc").skip((page - 1) * pageSize).limit(pageSize).get(),
  ]);
  return success({ items: dataResult.data.map(publicNotice), page, total: countResult.total, hasMore: page * pageSize < countResult.total });
}

async function get(user, event) {
  const item = await findNotice(cleanText(event.id, 64), user.familyId);
  return item ? success(publicNotice(item)) : failure("通知不存在或无权查看");
}

async function save(user, event, updating) {
  if (user.role === "child") return failure("孩子账号不能维护通知");
  const payload = validatePayload(event);
  if (payload.error) return failure(payload.error);
  if (updating) {
    let id;
    try {
      id = await db.runTransaction(async (transaction) => {
        const item = await findNotice(cleanText(event.id, 64), user.familyId, transaction);
        if (!item) return "";
        const data = { ...payload.data };
        Object.assign(data, buildReminderFields(data, item));
        await transaction.collection("notices").doc(item._id).update({ data });
        return item._id;
      });
    } catch (error) {
      if (error.message === "INVALID_ADVANCE") return failure("每条通知只能选择一个提醒时间");
      if (error.message === "MISSING_TARGETS") return failure("请至少选择一个提醒对象");
      throw error;
    }
    return id ? success({ id }, "通知已更新") : failure("通知不存在或无权编辑");
  }
  try {
    Object.assign(payload.data, buildReminderFields(payload.data));
  } catch (error) {
    if (error.message === "INVALID_ADVANCE") return failure("每条通知只能选择一个提醒时间");
    if (error.message === "MISSING_TARGETS") return failure("请至少选择一个提醒对象");
    throw error;
  }
  const result = await db.collection("notices").add({ data: { familyId: user.familyId, ...payload.data, createdAt: new Date(), createdBy: user.openid, createdByName: RELATION_NAMES[user.relation] || user.nickname } });
  return success({ id: result._id }, "通知已保存");
}

async function remove(user, event) {
  if (user.role === "child") return failure("孩子账号不能删除通知");
  const item = await findNotice(cleanText(event.id, 64), user.familyId);
  if (!item) return failure("通知不存在或无权删除");
  await db.collection("notices").doc(item._id).remove();
  return success(null, "通知已删除");
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  try {
    const user = await requireUser(OPENID);
    switch (event.action) {
      case "list": return await list(user, event);
      case "get": return await get(user, event);
      case "create": return await save(user, event, false);
      case "update": return await save(user, event, true);
      case "remove": return await remove(user, event);
      default: return failure("不支持的操作");
    }
  } catch (error) {
    console.error("Notice action failed", { action: event.action, message: error.message, stack: error.stack });
    return failure(error.message === "UNAUTHORIZED" ? "请先登录并加入家庭" : "通知服务暂时不可用，请稍后重试");
  }
};
