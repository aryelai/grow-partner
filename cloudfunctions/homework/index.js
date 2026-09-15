const cloud = require("wx-server-sdk");
const crypto = require("crypto");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const RELATION_NAMES = { father: "爸爸", mother: "妈妈", grandpa_paternal: "爷爷", grandma_paternal: "奶奶", grandpa_maternal: "外公", grandma_maternal: "外婆", uncle_paternal: "叔叔", aunt_paternal: "婶婶", uncle_maternal: "舅舅", aunt_maternal: "舅妈", brother: "哥哥", sister: "姐姐", child: "孩子" };
const CREATE_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

function success(data, message = "") { return { success: true, data, message }; }
function failure(message) { return { success: false, data: null, message }; }
function cleanText(value, maxLength) { return typeof value === "string" ? value.trim().slice(0, maxLength) : ""; }
function cleanArray(value, maxLength) { return Array.isArray(value) ? value.slice(0, maxLength) : []; }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function documentMissing(error) {
  return Boolean(error && (error.code === "DOCUMENT_NOT_FOUND"
    || /document.*(?:does not exist|not found)/i.test(String(error.errMsg || error.message || ""))));
}
function parseCreateRequestId(event) {
  if (!Object.hasOwn(event, "requestId") || event.requestId === undefined || event.requestId === "") {
    return { requestId: "" };
  }
  if (typeof event.requestId !== "string" || event.requestId !== event.requestId.trim()
    || !CREATE_REQUEST_ID_PATTERN.test(event.requestId)) {
    return { error: "创建请求编号不正确" };
  }
  return { requestId: event.requestId };
}
function createHomeworkId(user, requestId) {
  return crypto.createHash("sha256")
    .update(["homework-create", user.familyId, user.openid, requestId].join("\u0000"))
    .digest("hex");
}
function publicHomework(value) {
  const { createdBy, ...safeValue } = value;
  return safeValue;
}

function isValidHomeworkDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

async function requireUser(openid) {
  if (!openid) throw new Error("UNAUTHORIZED");
  const result = await db.collection("users").where({ openid }).limit(1).get();
  const user = result.data[0];
  if (!user || !user.familyId || !["creator", "member", "child"].includes(user.role)) throw new Error("UNAUTHORIZED");
  return user;
}

async function findOwnedHomework(id, familyId) {
  if (!id) return null;
  try {
    const item = (await db.collection("homework").doc(id).get()).data;
    return item && item.familyId === familyId ? item : null;
  } catch (error) {
    if (String(error.errMsg || error.message).includes("exist")) return null;
    throw error;
  }
}

function validatePayload(event, fallbackDate) {
  const title = typeof event.title === "string" ? event.title.trim() : "";
  const homeworkDate = Object.hasOwn(event, "homeworkDate") ? event.homeworkDate : fallbackDate;
  const subject = cleanText(event.subject, 20);
  const semester = cleanText(event.semester, 8);
  const content = cleanText(event.content, 2000);
  const extraRequirement = cleanText(event.extraRequirement, 100);
  const images = cleanArray(event.images, 9).filter((item) => typeof item === "string" && item.startsWith("cloud://"));
  const videos = cleanArray(event.videos, 1).filter((item) => typeof item === "string" && item.startsWith("cloud://"));
  const links = cleanArray(event.links, 5).map((item) => cleanText(item, 500)).filter((item) => /^https?:\/\//i.test(item));
  const extraTags = cleanArray(event.extraTags, 10).map((item) => cleanText(item, 10)).filter(Boolean);
  const hasDeadline = event.hasDeadline === true;
  const deadline = hasDeadline ? new Date(event.deadline) : null;
  if (!title || !subject || !/^\d{4}(上|下)$/.test(semester)) return { error: "请完整填写学期、科目和主题" };
  if (title.length > 500) return { error: "主题不能超过500字，请精简后保存" };
  if ((Object.hasOwn(event, "homeworkDate") || homeworkDate !== undefined) && !isValidHomeworkDate(homeworkDate)) {
    return { error: "请选择正确的作业日期" };
  }
  if (hasDeadline && Number.isNaN(deadline.getTime())) return { error: "截止时间格式不正确" };
  if (images.length !== cleanArray(event.images, 9).length || videos.length !== cleanArray(event.videos, 1).length || links.length !== cleanArray(event.links, 5).length) {
    return { error: "媒体或链接格式不正确" };
  }
  return {
    data: {
      semester, subject, title, content, images, videos, links, extraRequirement,
      ...(homeworkDate !== undefined ? { homeworkDate } : {}),
      isImportant: event.isImportant === true,
      hasDeadline,
      deadline,
      extraTags,
    },
  };
}

function sortItems(items) {
  const now = Date.now();
  return [...items].sort((left, right) => {
    if (Boolean(left.isCompleted) !== Boolean(right.isCompleted)) return left.isCompleted ? 1 : -1;
    const leftDeadline = left.hasDeadline && left.deadline ? new Date(left.deadline).getTime() : Number.POSITIVE_INFINITY;
    const rightDeadline = right.hasDeadline && right.deadline ? new Date(right.deadline).getTime() : Number.POSITIVE_INFINITY;
    const leftActive = leftDeadline >= now;
    const rightActive = rightDeadline >= now;
    if (leftActive !== rightActive) return leftActive ? -1 : 1;
    if (leftActive && leftDeadline !== rightDeadline) return leftDeadline - rightDeadline;
    if (Boolean(left.isImportant) !== Boolean(right.isImportant)) return left.isImportant ? -1 : 1;
    return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
  });
}

async function list(user, event) {
  const page = Math.max(1, Number.parseInt(event.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, Number.parseInt(event.pageSize, 10) || 20));
  const sortMode = cleanText(event.sortMode, 32);
  if (sortMode && sortMode !== "created_at_desc") return failure("排序方式不正确");
  const query = { familyId: user.familyId };
  const semester = cleanText(event.semester, 8);
  if (semester) query.semester = semester;
  const subject = cleanText(event.subject, 20);
  if (subject && subject !== "全部") query.subject = subject;
  if (event.status === "completed") query.isCompleted = true;
  if (event.status === "pending") query.isCompleted = false;
  const keyword = cleanText(event.keyword, 50);
  if (keyword) query.title = db.RegExp({ regexp: escapeRegExp(keyword), options: "i" });

  const collection = db.collection("homework").where(query);
  const countResult = await collection.count();
  if (sortMode === "created_at_desc") {
    const start = (page - 1) * pageSize;
    const result = await collection.orderBy("createdAt", "desc").skip(start).limit(pageSize).get();
    return success({
      items: result.data.map(publicHomework),
      page,
      pageSize,
      total: countResult.total,
      hasMore: page * pageSize < countResult.total,
      truncated: false,
    });
  }
  const candidateLimit = Math.min(countResult.total, 500);
  const candidates = [];
  for (let offset = 0; offset < candidateLimit; offset += 50) {
    const batch = await collection.orderBy("createdAt", "desc").skip(offset).limit(Math.min(50, candidateLimit - offset)).get();
    candidates.push(...batch.data);
  }
  const sorted = sortItems(candidates);
  const start = (page - 1) * pageSize;
  return success({
    items: sorted.slice(start, start + pageSize).map(publicHomework),
    page,
    pageSize,
    total: countResult.total,
    hasMore: page * pageSize < candidateLimit,
    truncated: countResult.total > candidateLimit,
  });
}

async function get(user, event) {
  const item = await findOwnedHomework(cleanText(event.id, 64), user.familyId);
  return item ? success(publicHomework(item)) : failure("作业不存在或无权查看");
}

async function create(user, event) {
  if (user.role === "child") return failure("孩子账号不能新增作业");
  const payload = validatePayload(event, new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10));
  if (payload.error) return failure(payload.error);
  const request = parseCreateRequestId(event);
  if (request.error) return failure(request.error);
  const data = {
    familyId: user.familyId,
    ...payload.data,
    isCompleted: false,
    createdAt: new Date(),
    createdBy: user.openid,
    createdByName: RELATION_NAMES[user.relation] || user.nickname,
  };
  if (request.requestId) {
    const id = createHomeworkId(user, request.requestId);
    const result = await db.runTransaction(async (transaction) => {
      const reference = transaction.collection("homework").doc(id);
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
    return success({ id: result.id, created: result.created }, result.created ? "作业已保存" : "作业已存在");
  }
  const result = await db.collection("homework").add({
    data,
  });
  return success({ id: result._id }, "作业已保存");
}

async function update(user, event) {
  if (user.role === "child") return failure("孩子账号不能编辑作业");
  const item = await findOwnedHomework(cleanText(event.id, 64), user.familyId);
  if (!item) return failure("作业不存在或无权编辑");
  const payload = validatePayload(event, item.homeworkDate);
  if (payload.error) return failure(payload.error);
  await db.collection("homework").doc(item._id).update({ data: payload.data });
  return success({ id: item._id }, "作业已更新");
}

async function remove(user, event) {
  if (user.role === "child") return failure("孩子账号不能删除作业");
  const item = await findOwnedHomework(cleanText(event.id, 64), user.familyId);
  if (!item) return failure("作业不存在或无权删除");
  if (user.role !== "creator" && item.createdBy !== user.openid) return failure("只能删除自己录入的作业");
  await db.collection("homework").doc(item._id).remove();
  return success(null, "作业已删除");
}

async function toggleCompleted(user, event) {
  const item = await findOwnedHomework(cleanText(event.id, 64), user.familyId);
  if (!item) return failure("作业不存在或无权操作");
  const isCompleted = event.isCompleted === true;
  await db.collection("homework").doc(item._id).update({
    data: { isCompleted },
  });
  return success({ id: item._id, isCompleted }, isCompleted ? "已标记完成" : "已取消完成");
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  try {
    const user = await requireUser(OPENID);
    switch (event.action) {
      case "list": return await list(user, event);
      case "get": return await get(user, event);
      case "create": return await create(user, event);
      case "update": return await update(user, event);
      case "remove": return await remove(user, event);
      case "toggleCompleted": return await toggleCompleted(user, event);
      default: return failure("不支持的操作");
    }
  } catch (error) {
    console.error("Homework action failed", { action: event.action, message: error.message, stack: error.stack });
    return failure(error.message === "UNAUTHORIZED" ? "请先登录并加入家庭" : "作业服务暂时不可用，请稍后重试");
  }
};
