const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const command = db.command;
const VALID_TYPES = new Set(["daily", "weekly", "monthly"]);
const VALID_PRIORITIES = new Set(["high", "medium", "low"]);
const VALID_ASSIGNEES = new Set(["father", "mother", "child", "all"]);
const RELATION_NAMES = { father: "爸爸", mother: "妈妈", grandpa_paternal: "爷爷", grandma_paternal: "奶奶", grandpa_maternal: "外公", grandma_maternal: "外婆", uncle_paternal: "叔叔", aunt_paternal: "婶婶", uncle_maternal: "舅舅", aunt_maternal: "舅妈", brother: "哥哥", sister: "姐姐", child: "孩子" };

function success(data, message = "") { return { success: true, data, message }; }
function failure(message) { return { success: false, data: null, message }; }
function cleanText(value, maxLength) { return typeof value === "string" ? value.trim().slice(0, maxLength) : ""; }
function isValidDate(value) { const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value); if (!matched) return false; const year = Number(matched[1]); const month = Number(matched[2]); const day = Number(matched[3]); const date = new Date(Date.UTC(year, month - 1, day)); return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day; }
function publicPlan(value) {
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

async function findPlan(id, familyId) {
  try {
    const item = (await db.collection("plans").doc(id).get()).data;
    return item && item.familyId === familyId ? item : null;
  } catch (error) {
    if (String(error.errMsg || error.message).includes("exist")) return null;
    throw error;
  }
}

function cleanIdArray(value) {
  return Array.isArray(value) ? [...new Set(value.map((item) => cleanText(item, 64)).filter(Boolean))].slice(0, 30) : [];
}

function validatePayload(event) {
  const type = cleanText(event.type, 16);
  const date = cleanText(event.date, 10);
  const semester = cleanText(event.semester, 8);
  const title = cleanText(event.title, 80);
  const assignee = cleanText(event.assignee, 16) || "child";
  const rawItems = Array.isArray(event.items) ? event.items.slice(0, 30) : [];
  const items = rawItems.map((item) => ({
    text: cleanText(item && item.text, 100),
    isDone: item && item.isDone === true,
    priority: VALID_PRIORITIES.has(item && item.priority) ? item.priority : "medium",
  })).filter((item) => item.text);
  if (!VALID_TYPES.has(type) || !isValidDate(date) || !/^\d{4}(上|下)$/.test(semester) || !title || !items.length || !VALID_ASSIGNEES.has(assignee)) {
    return { error: "请完整填写计划类型、日期、标题、子任务和执行人" };
  }
  return { data: { type, date, semester, title, items, assignee, notes: cleanText(event.notes, 500), linkedHomeworkIds: cleanIdArray(event.linkedHomeworkIds), linkedHabitIds: cleanIdArray(event.linkedHabitIds), isCompleted: items.every((item) => item.isDone) } };
}

async function list(user, event) {
  const page = Math.max(1, Number.parseInt(event.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, Number.parseInt(event.pageSize, 10) || 20));
  const type = cleanText(event.type, 16);
  const query = { familyId: user.familyId };
  if (VALID_TYPES.has(type)) query.type = type;
  const semester = cleanText(event.semester, 8);
  if (semester) query.semester = semester;
  const start = cleanText(event.start, 10);
  const end = cleanText(event.end, 10);
  if (isValidDate(start) && isValidDate(end)) query.date = command.gte(start).and(command.lte(end));
  const collection = db.collection("plans").where(query);
  const [countResult, dataResult] = await Promise.all([
    collection.count(),
    collection.orderBy("date", "asc").orderBy("createdAt", "desc").skip((page - 1) * pageSize).limit(pageSize).get(),
  ]);
  return success({ items: dataResult.data.map(publicPlan), page, total: countResult.total, hasMore: page * pageSize < countResult.total });
}

async function get(user, event) {
  const item = await findPlan(cleanText(event.id, 64), user.familyId);
  return item ? success(publicPlan(item)) : failure("计划不存在或无权查看");
}

async function save(user, event, updating) {
  if (user.role === "child") return failure("孩子账号不能维护计划");
  const payload = validatePayload(event);
  if (payload.error) return failure(payload.error);
  if (updating) {
    const item = await findPlan(cleanText(event.id, 64), user.familyId);
    if (!item) return failure("计划不存在或无权编辑");
    await db.collection("plans").doc(item._id).update({ data: payload.data });
    return success({ id: item._id }, "计划已更新");
  }
  const result = await db.collection("plans").add({ data: { familyId: user.familyId, ...payload.data, createdAt: new Date(), createdBy: user.openid, createdByName: RELATION_NAMES[user.relation] || user.nickname } });
  return success({ id: result._id }, "计划已保存");
}

async function toggleItem(user, event) {
  const item = await findPlan(cleanText(event.id, 64), user.familyId);
  const itemIndex = Number(event.itemIndex);
  if (!item || !Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex >= item.items.length) return failure("计划或子任务不存在");
  const items = item.items.map((planItem, index) => index === itemIndex ? { ...planItem, isDone: event.isDone === true } : planItem);
  await db.collection("plans").doc(item._id).update({ data: { items, isCompleted: items.every((planItem) => planItem.isDone) } });
  return success({ id: item._id, items }, "计划进度已更新");
}

async function remove(user, event) {
  if (user.role === "child") return failure("孩子账号不能删除计划");
  const item = await findPlan(cleanText(event.id, 64), user.familyId);
  if (!item) return failure("计划不存在或无权删除");
  await db.collection("plans").doc(item._id).remove();
  return success(null, "计划已删除");
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
      case "toggleItem": return await toggleItem(user, event);
      case "remove": return await remove(user, event);
      default: return failure("不支持的操作");
    }
  } catch (error) {
    console.error("Plan action failed", { action: event.action, message: error.message, stack: error.stack });
    return failure(error.message === "UNAUTHORIZED" ? "请先登录并加入家庭" : "计划服务暂时不可用，请稍后重试");
  }
};
