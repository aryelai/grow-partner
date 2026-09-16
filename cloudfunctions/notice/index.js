const cloud = require("wx-server-sdk");
const crypto = require("crypto");
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
const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

function success(data, message = "") { return { success: true, data, message }; }
function failure(message) { return { success: false, data: null, message }; }
function cleanText(value, maxLength) { return typeof value === "string" ? value.trim().slice(0, maxLength) : ""; }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function documentMissing(error) {
  return Boolean(error && (error.code === "DOCUMENT_NOT_FOUND"
    || /document.*(?:does not exist|not found)/i.test(String(error.errMsg || error.message || ""))));
}
function createNoticeId(user, requestId) {
  return crypto.createHash("sha256")
    .update(["notice-create", user.familyId, user.openid, requestId].join("\u0000"))
    .digest("hex");
}
function publicNotice(value) {
  const { createdBy, aiImportRequestId, ...safeValue } = value;
  return { ...safeValue, isCompleted: value.isCompleted === true };
}

function optionalTime(value) {
  if (value === null || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : new Date(value.getTime());
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined;
  const clock = /T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(value);
  const zone = /[+-](\d{2}):(\d{2})$/.exec(value);
  if (Number(clock[1]) > 23 || Number(clock[2]) > 59 || Number(clock[3] || 0) > 59) return undefined;
  if (zone && (Number(zone[1]) > 14 || Number(zone[2]) > 59 || (Number(zone[1]) === 14 && Number(zone[2]) !== 0))) return undefined;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() + 1 !== month || calendarDate.getUTCDate() !== day) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
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
  const times = {};
  for (const field of ["eventTime", "deadline"]) {
    if (!Object.prototype.hasOwnProperty.call(event, field)) continue;
    const time = optionalTime(event[field]);
    if (time === undefined) return { error: "事项或截止时间格式不正确" };
    times[field] = time;
  }
  return { data: { semester, title, content: cleanText(event.content, 3000), images, source: cleanText(event.source, 60), category, remindTime, remindAdvance: remindAdvance === null ? [] : [remindAdvance], remindTargets, ...times } };
}

async function list(user, event) {
  const page = Math.max(1, Number.parseInt(event.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, Number.parseInt(event.pageSize, 10) || 20));
  const query = { familyId: user.familyId };
  const semester = cleanText(event.semester, 8);
  if (semester) query.semester = semester;
  const category = cleanText(event.category, 32);
  if (category && category !== "all") query.category = category;
  const status = cleanText(event.status, 16) || "all";
  if (!["all", "pending", "completed"].includes(status)) return failure("通知处理状态不正确");
  // 缺少完成字段的旧通知仍属于待处理，不依赖提醒发送状态。
  if (status === "pending") query.isCompleted = db.command.neq(true);
  if (status === "completed") query.isCompleted = true;
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
  const clientRequestId = cleanText(event.clientRequestId, 64);
  if (clientRequestId && !CLIENT_REQUEST_ID_PATTERN.test(clientRequestId)) return failure("通知导入请求编号不正确");
  try {
    Object.assign(payload.data, buildReminderFields(payload.data));
  } catch (error) {
    if (error.message === "INVALID_ADVANCE") return failure("每条通知只能选择一个提醒时间");
    if (error.message === "MISSING_TARGETS") return failure("请至少选择一个提醒对象");
    throw error;
  }
  const data = { familyId: user.familyId, ...payload.data, ...(clientRequestId ? { aiImportRequestId: clientRequestId } : {}), isCompleted: false, completedAt: null, completedByName: "", createdAt: new Date(), createdBy: user.openid, createdByName: RELATION_NAMES[user.relation] || user.nickname };
  if (clientRequestId) {
    const id = createNoticeId(user, clientRequestId);
    const result = await db.runTransaction(async (transaction) => {
      const reference = transaction.collection("notices").doc(id);
      let existing = null;
      try {
        existing = (await reference.get()).data;
      } catch (error) {
        if (!documentMissing(error)) throw error;
      }
      if (existing) {
        if (existing.familyId !== user.familyId || existing.createdBy !== user.openid) {
          throw new Error("IDEMPOTENCY_CONFLICT");
        }
        return { id, created: false };
      }
      await reference.set({ data });
      return { id, created: true };
    });
    return success({ id: result.id, created: result.created }, result.created ? "通知已保存" : "通知已存在");
  }
  const result = await db.collection("notices").add({ data });
  return success({ id: result._id }, "通知已保存");
}

async function toggleCompleted(user, event) {
  if (user.role === "child") return failure("孩子账号不能维护通知");
  if (typeof event.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(event.id) || typeof event.isCompleted !== "boolean") return failure("通知标识或完成状态不正确");
  const result = await db.runTransaction(async (transaction) => {
    const item = await findNotice(event.id, user.familyId, transaction);
    if (!item) return null;
    if ((item.isCompleted === true) !== event.isCompleted) {
      await transaction.collection("notices").doc(item._id).update({ data: {
        isCompleted: event.isCompleted,
        completedAt: event.isCompleted ? new Date() : null,
        completedByName: event.isCompleted ? cleanText(RELATION_NAMES[user.relation] || user.nickname, 40) : "",
      } });
    }
    return { id: item._id, isCompleted: event.isCompleted };
  });
  return result ? success(result, result.isCompleted ? "通知事项已完成" : "通知已恢复待处理") : failure("通知不存在或无权维护");
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
      case "toggleCompleted": return await toggleCompleted(user, event);
      case "remove": return await remove(user, event);
      default: return failure("不支持的操作");
    }
  } catch (error) {
    console.error("Notice action failed", { action: event.action, message: error.message, stack: error.stack });
    return failure(error.message === "UNAUTHORIZED" ? "请先登录并加入家庭" : "通知服务暂时不可用，请稍后重试");
  }
};
