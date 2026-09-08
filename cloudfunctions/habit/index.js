const cloud = require("wx-server-sdk");
const crypto = require("crypto");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const command = db.command;
const VALID_CATEGORIES = new Set(["behavior", "life", "study"]);
const VALID_FREQUENCIES = new Set(["daily", "weekly"]);
const RELATION_NAMES = { father: "爸爸", mother: "妈妈", grandpa_paternal: "爷爷", grandma_paternal: "奶奶", grandpa_maternal: "外公", grandma_maternal: "外婆", uncle_paternal: "叔叔", aunt_paternal: "婶婶", uncle_maternal: "舅舅", aunt_maternal: "舅妈", brother: "哥哥", sister: "姐姐", child: "孩子" };

function success(data, message = "") { return { success: true, data, message }; }
function failure(message) { return { success: false, data: null, message }; }
function cleanText(value, maxLength) { return typeof value === "string" ? value.trim().slice(0, maxLength) : ""; }
function isValidDate(value) { const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value); if (!matched) return false; const year = Number(matched[1]); const month = Number(matched[2]); const day = Number(matched[3]); const date = new Date(Date.UTC(year, month - 1, day)); return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day; }
function publicHabit(value) {
  const { createdBy, ...safeValue } = value;
  return safeValue;
}
function publicCheckIn(value) {
  const { checkedByOpenid, ...safeValue } = value;
  return safeValue;
}

function shiftDate(dateText, offset) {
  const parts = dateText.split("-").map(Number);
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function getShanghaiDate() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function calculateStreak(checkIns, targetDate) {
  const completed = new Set(checkIns.filter((item) => item.status === "completed").map((item) => item.date));
  let cursor = targetDate;
  let streak = 0;
  while (completed.has(cursor)) { streak += 1; cursor = shiftDate(cursor, -1); }
  return streak;
}

function calculatePointEntries(streak, completedTarget) {
  const entries = [{ change: 1, reason: "完成每日打卡" }];
  const milestones = { 7: 3, 21: 10, 30: 15 };
  if (milestones[streak]) entries.push({ change: milestones[streak], reason: `连续${streak}天打卡奖励` });
  if (completedTarget) entries.push({ change: 50, reason: "完成一项习惯目标" });
  return entries;
}

async function requireUser(openid) {
  if (!openid) throw new Error("UNAUTHORIZED");
  const result = await db.collection("users").where({ openid }).limit(1).get();
  const user = result.data[0];
  if (!user || !user.familyId || !["creator", "member", "child"].includes(user.role)) throw new Error("UNAUTHORIZED");
  return user;
}

async function findHabit(id, familyId) {
  try {
    const item = (await db.collection("habits").doc(id).get()).data;
    return item && item.familyId === familyId ? item : null;
  } catch (error) {
    if (String(error.errMsg || error.message).includes("exist")) return null;
    throw error;
  }
}

function validatePayload(event) {
  const name = cleanText(event.name, 50);
  const category = cleanText(event.category, 16);
  const frequency = cleanText(event.frequency, 16) || "daily";
  const targetDays = Math.min(365, Math.max(1, Number.parseInt(event.targetDays, 10) || 21));
  const semester = cleanText(event.semester, 8);
  const startDate = cleanText(event.startDate, 10);
  const rawItems = Array.isArray(event.checkInItems) ? event.checkInItems.slice(0, 10) : [];
  const checkInItems = rawItems.map((item) => ({ name: cleanText(item && item.name, 40), required: !item || item.required !== false })).filter((item) => item.name);
  if (!name || !VALID_CATEGORIES.has(category) || !VALID_FREQUENCIES.has(frequency) || !/^\d{4}(上|下)$/.test(semester) || !isValidDate(startDate) || !checkInItems.length) return { error: "请完整填写习惯名称、分类、周期和打卡项" };
  if (event.endDate && !isValidDate(event.endDate)) return { error: "习惯结束日期格式不正确" };
  return { data: { name, category, description: cleanText(event.description, 500), frequency, targetDays, checkInItems, startDate, endDate: event.endDate || null, semester, isActive: event.isActive !== false, reward: cleanText(event.reward, 100) } };
}

async function getCheckIns(habitId, start, end) {
  return (await db.collection("habit_checkins").where({ habitId, date: command.gte(start).and(command.lte(end)) }).orderBy("date", "asc").limit(100).get()).data;
}

async function list(user, event) {
  const page = Math.max(1, Number.parseInt(event.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, Number.parseInt(event.pageSize, 10) || 20));
  const query = { familyId: user.familyId, isActive: true };
  const semester = cleanText(event.semester, 8); if (semester) query.semester = semester;
  const category = cleanText(event.category, 16); if (VALID_CATEGORIES.has(category)) query.category = category;
  const collection = db.collection("habits").where(query);
  const [countResult, habitResult] = await Promise.all([collection.count(), collection.orderBy("createdAt", "desc").skip((page - 1) * pageSize).limit(pageSize).get()]);
  const requestedToday = cleanText(event.today, 10);
  const today = isValidDate(requestedToday) ? requestedToday : getShanghaiDate();
  const start = shiftDate(today, -60);
  const items = await Promise.all(habitResult.data.map(async (habit) => {
    const checkIns = await getCheckIns(habit._id, start, today);
    const completedDays = checkIns.filter((item) => item.status === "completed").length;
    return { ...publicHabit(habit), streak: calculateStreak(checkIns, today), completedDays, progress: Math.min(100, Math.round(completedDays * 100 / habit.targetDays)) };
  }));
  return success({ items, page, total: countResult.total, hasMore: page * pageSize < countResult.total });
}

async function get(user, event) {
  const habit = await findHabit(cleanText(event.id, 64), user.familyId);
  if (!habit) return failure("习惯不存在或无权查看");
  const requestedToday = cleanText(event.today, 10);
  const today = isValidDate(requestedToday) ? requestedToday : getShanghaiDate();
  const month = /^\d{4}-\d{2}$/.test(event.month || "") ? event.month : today.slice(0, 7);
  const endDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const checkIns = await getCheckIns(habit._id, `${month}-01`, `${month}-${String(endDay).padStart(2, "0")}`);
  const recent = await getCheckIns(habit._id, shiftDate(today, -60), today);
  const pointsResult = await db.collection("habit_points").where({ familyId: user.familyId }).limit(1).get();
  return success({ habit: publicHabit(habit), checkIns: checkIns.map(publicCheckIn), streak: calculateStreak(recent, today), totalPoints: pointsResult.data[0] ? pointsResult.data[0].totalPoints : 0 });
}

async function save(user, event, updating) {
  if (user.role === "child") return failure("孩子账号不能维护习惯");
  const payload = validatePayload(event); if (payload.error) return failure(payload.error);
  if (updating) {
    const habit = await findHabit(cleanText(event.id, 64), user.familyId); if (!habit) return failure("习惯不存在或无权编辑");
    await db.collection("habits").doc(habit._id).update({ data: payload.data });
    return success({ id: habit._id }, "习惯已更新");
  }
  const result = await db.collection("habits").add({ data: { familyId: user.familyId, ...payload.data, createdAt: new Date(), createdBy: user.openid } });
  return success({ id: result._id }, "习惯已创建");
}

async function checkIn(user, event) {
  const habit = await findHabit(cleanText(event.habitId, 64), user.familyId);
  const date = cleanText(event.date, 10);
  if (!habit || !isValidDate(date)) return failure("习惯或打卡日期不正确");
  if (date !== getShanghaiDate()) return failure("仅可保存今日打卡");
  if (habit.isActive !== true || date < habit.startDate || (habit.endDate && date > habit.endDate)) {
    return failure("当前习惯不在可打卡周期");
  }
  const submitted = Array.isArray(event.items) ? event.items : [];
  const items = habit.checkInItems.map((definition) => ({ name: definition.name, done: submitted.some((item) => item && item.name === definition.name && item.done === true) }));
  const requiredItems = habit.checkInItems.filter((item) => item.required !== false);
  const completedRequired = requiredItems.every((definition) => items.some((item) => item.name === definition.name && item.done));
  const anyCompleted = items.some((item) => item.done);
  const status = completedRequired ? "completed" : anyCompleted ? "partial" : "missed";
  const photo = cleanText(event.photo, 1024);
  if (photo && !photo.startsWith("cloud://")) return failure("打卡照片地址格式不正确");

  const record = { habitId: habit._id, familyId: user.familyId, date, status, items, photo, note: cleanText(event.note, 300), checkedBy: RELATION_NAMES[user.relation] || user.nickname, checkedByOpenid: user.openid, createdAt: new Date() };
  const checkInId = crypto.createHash("sha256").update(`${habit._id}:${date}`).digest("hex").slice(0, 32);
  const pointsId = crypto.createHash("sha256").update(`points:${user.familyId}`).digest("hex").slice(0, 32);

  await db.runTransaction(async (transaction) => {
    let existing = null;
    try { existing = (await transaction.collection("habit_checkins").doc(checkInId).get()).data; }
    catch (error) { if (!String(error.errMsg || error.message).includes("exist")) throw error; }
    const pointsAwarded = Boolean(existing && (existing.pointsAwarded === true || existing.status === "completed"));
    const shouldAwardPoints = status === "completed" && !pointsAwarded;
    const nextRecord = { ...record, pointsAwarded: pointsAwarded || status === "completed" };

    let recent = [];
    let completedBefore = 0;
    if (shouldAwardPoints) {
      const recentResult = await transaction.collection("habit_checkins").where({ habitId: habit._id, familyId: user.familyId, date: command.gte(shiftDate(date, -60)).and(command.lte(date)) }).limit(100).get();
      recent = [...recentResult.data.filter((item) => item.date !== date), nextRecord];
      completedBefore = (await transaction.collection("habit_checkins").where({ habitId: habit._id, familyId: user.familyId, status: "completed" }).limit(365).get()).data.length;
    }

    await transaction.collection("habit_checkins").doc(checkInId).set({ data: nextRecord });
    if (!shouldAwardPoints) return;

    const streak = calculateStreak(recent, date);
    const pointEntries = calculatePointEntries(streak, completedBefore + 1 === habit.targetDays).map((item) => ({ ...item, date }));
    const added = pointEntries.reduce((sum, item) => sum + item.change, 0);
    let current = null;
    try { current = (await transaction.collection("habit_points").doc(pointsId).get()).data; }
    catch (error) { if (!String(error.errMsg || error.message).includes("exist")) throw error; }
    await transaction.collection("habit_points").doc(pointsId).set({
      data: {
        familyId: user.familyId,
        totalPoints: (current ? current.totalPoints : 0) + added,
        history: [...(current && current.history ? current.history : []), ...pointEntries].slice(-200),
      },
    });
  });
  return success({ status }, "打卡已保存");
}

async function remove(user, event) {
  if (user.role === "child") return failure("孩子账号不能删除习惯");
  const habit = await findHabit(cleanText(event.id, 64), user.familyId); if (!habit) return failure("习惯不存在或无权删除");
  await db.collection("habits").doc(habit._id).update({ data: { isActive: false } });
  return success(null, "习惯已停用");
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
      case "checkIn": return await checkIn(user, event);
      case "remove": return await remove(user, event);
      default: return failure("不支持的操作");
    }
  } catch (error) {
    console.error("Habit action failed", { action: event.action, message: error.message, stack: error.stack });
    return failure(error.message === "UNAUTHORIZED" ? "请先登录并加入家庭" : "习惯服务暂时不可用，请稍后重试");
  }
};
