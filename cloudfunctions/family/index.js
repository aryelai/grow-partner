const cloud = require("wx-server-sdk");
const crypto = require("crypto");
const {
  formatInviteCode,
  generateInviteCode,
  isValidInviteCode,
  normalizeInviteCode,
} = require("./invite-code");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const VALID_STAGES = new Set(["kindergarten", "primary", "junior_high", "senior_high"]);
const VALID_RELATIONS = new Set([
  "father", "mother", "grandpa_paternal", "grandma_paternal",
  "grandpa_maternal", "grandma_maternal", "uncle_paternal",
  "aunt_paternal", "uncle_maternal", "aunt_maternal",
  "brother", "sister", "child",
]);
const VALID_CREATOR_RELATIONS = new Set([
  "father", "mother", "grandpa_paternal", "grandma_paternal",
  "grandpa_maternal", "grandma_maternal", "uncle_paternal",
  "aunt_paternal", "uncle_maternal", "aunt_maternal",
]);
const VALID_GRADES = {
  kindergarten: new Set(["小班", "中班", "大班"]),
  primary: new Set(["1", "2", "3", "4", "5", "6"]),
  junior_high: new Set(["1", "2", "3"]),
  senior_high: new Set(["1", "2", "3"]),
};
const RELATION_NAMES = {
  father: "爸爸", mother: "妈妈", grandpa_paternal: "爷爷",
  grandma_paternal: "奶奶", grandpa_maternal: "外公",
  grandma_maternal: "外婆", uncle_paternal: "叔叔",
  aunt_paternal: "婶婶", uncle_maternal: "舅舅",
  aunt_maternal: "舅妈", brother: "哥哥", sister: "姐姐", child: "孩子",
};

function success(data, message = "") {
  return { success: true, data, message };
}

function failure(message) {
  return { success: false, data: null, message };
}

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function publicFamily(family) {
  const { creatorOpenid, inviteCode, ...safeFamily } = family;
  return safeFamily;
}

function isValidDate(value) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!matched) return false;
  const year = Number(matched[1]); const month = Number(matched[2]); const day = Number(matched[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

async function getUser(openid, database = db) {
  const result = await database.collection("users").where({ openid }).limit(1).get();
  return result.data[0] || null;
}

async function requireUser(openid) {
  const user = await getUser(openid);
  if (!user) throw new Error("UNREGISTERED");
  return user;
}

async function requireCreator(openid) {
  const user = await requireUser(openid);
  if (user.role !== "creator" || !user.familyId) throw new Error("FORBIDDEN");
  return user;
}

async function createInviteCode() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const inviteCode = generateInviteCode();
    const existing = await db.collection("families").where({ inviteCode }).limit(1).get();
    if (!existing.data.length) return inviteCode;
  }
  throw new Error("INVITE_CODE_UNAVAILABLE");
}

async function createFamily(openid, event) {
  const user = await requireUser(openid);
  if (user.familyId) return failure("您已经加入家庭");
  const childName = cleanText(event.childName, 20);
  const childBirthday = cleanText(event.childBirthday, 10);
  const educationStage = cleanText(event.educationStage, 32);
  const grade = cleanText(event.grade, 8);
  const relation = cleanText(event.relation, 32);
  if (!childName || !isValidDate(childBirthday) || new Date(`${childBirthday}T00:00:00.000Z`).getTime() > Date.now() || !VALID_STAGES.has(educationStage) || !VALID_GRADES[educationStage].has(grade) || !VALID_CREATOR_RELATIONS.has(relation)) {
    return failure("孩子档案信息不完整或格式不正确");
  }
  const inviteCode = await createInviteCode();

  const result = await db.runTransaction(async (transaction) => {
    const latestUser = await getUser(openid, transaction);
    if (!latestUser || latestUser.familyId) throw new Error("CONFLICT");
    const familyResult = await transaction.collection("families").add({
      data: {
        childName,
        childNickname: cleanText(event.childNickname, 20),
        childBirthday: new Date(`${childBirthday}T00:00:00.000Z`),
        educationStage,
        grade,
        className: cleanText(event.className, 30),
        currentSemester: /^\d{4}(上|下)$/.test(event.currentSemester) ? event.currentSemester : "2026下",
        inviteCode,
        creatorOpenid: openid,
        allowMemberEditSettings: false,
        createdAt: new Date(),
      },
    });
    await transaction.collection("users").doc(latestUser._id).update({
      data: { familyId: familyResult._id, relation, role: "creator" },
    });
    return familyResult._id;
  });
  return success({ familyId: result, inviteCode, inviteCodeDisplay: formatInviteCode(inviteCode) }, "家庭创建成功");
}

async function searchByInviteCode(openid, event) {
  const user = await requireUser(openid);
  if (user.familyId) return failure("您已经加入家庭");
  const inviteCode = normalizeInviteCode(event.inviteCode);
  if (!isValidInviteCode(inviteCode)) return failure("邀请码格式不正确");
  const date = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const limitId = crypto.createHash("sha256").update(`family-search:${openid}:${date}`).digest("hex").slice(0, 32);
  await db.runTransaction(async (transaction) => {
    let current = null;
    try { current = (await transaction.collection("family_search_limits").doc(limitId).get()).data; }
    catch (error) { if (!String(error.errMsg || error.message).includes("exist")) throw error; }
    if (current && current.count >= 20) throw new Error("RATE_LIMIT");
    await transaction.collection("family_search_limits").doc(limitId).set({
      data: { openid, date, count: (current ? current.count : 0) + 1, updatedAt: new Date() },
    });
  });
  const result = await db.collection("families").where({ inviteCode }).limit(1).get();
  const family = result.data[0];
  if (!family) return failure("未找到可加入的家庭");
  return success({
    _id: family._id,
    childName: family.childName,
    childNickname: family.childNickname,
    className: family.className,
    educationStage: family.educationStage,
    grade: family.grade,
  });
}

async function applyJoin(openid, event) {
  const user = await requireUser(openid);
  if (user.familyId) return failure("您已经加入家庭");
  const familyId = cleanText(event.familyId, 64);
  const inviteCode = normalizeInviteCode(event.inviteCode);
  const relation = cleanText(event.relation, 32);
  if (!familyId || !isValidInviteCode(inviteCode) || !VALID_RELATIONS.has(relation)) return failure("申请信息不完整");
  let family;
  try {
    family = (await db.collection("families").doc(familyId).get()).data;
  } catch (error) {
    const errorCode = String(error.code || error.errCode || "");
    const errorMessage = String(error.errMsg || error.message || "");
    if (errorCode === "DOCUMENT_NOT_FOUND" || /document.*(?:does not exist|not found)/i.test(errorMessage)) {
      return failure("目标家庭不存在");
    }
    throw error;
  }
  if (!family || family.inviteCode !== inviteCode) return failure("邀请码与目标家庭不匹配");
  const duplicate = await db.collection("family_join_requests")
    .where({ familyId, applicantOpenid: openid, status: "pending" })
    .limit(1)
    .get();
  if (duplicate.data.length) return failure("您已有待处理申请");
  await db.collection("family_join_requests").add({
    data: {
      familyId,
      applicantOpenid: openid,
      relation,
      status: "pending",
      createdAt: new Date(),
      reviewedAt: null,
      reviewedBy: "",
    },
  });
  return success(null, "申请已提交");
}

async function listRequests(openid) {
  const creator = await requireCreator(openid);
  const result = await db.collection("family_join_requests")
    .where({ familyId: creator.familyId, status: "pending" })
    .orderBy("createdAt", "asc")
    .limit(50)
    .get();
  const users = await Promise.all(result.data.map((request) => getUser(request.applicantOpenid)));
  return success(result.data.map((request, index) => ({
    ...request,
    applicantName: users[index] ? users[index].nickname : "家庭成员",
    relationName: RELATION_NAMES[request.relation] || "成员",
    applicantOpenid: undefined,
    reviewedBy: undefined,
  })));
}

async function reviewJoin(openid, event) {
  const creator = await requireCreator(openid);
  const requestId = cleanText(event.requestId, 64);
  if (!requestId || typeof event.approved !== "boolean") return failure("审批参数不正确");

  await db.runTransaction(async (transaction) => {
    const request = (await transaction.collection("family_join_requests").doc(requestId).get()).data;
    if (!request || request.familyId !== creator.familyId || request.status !== "pending") {
      throw new Error("INVALID_REQUEST");
    }
    const applicant = await getUser(request.applicantOpenid, transaction);
    if (!applicant || applicant.familyId) throw new Error("APPLICANT_UNAVAILABLE");
    await transaction.collection("family_join_requests").doc(requestId).update({
      data: {
        status: event.approved ? "approved" : "rejected",
        reviewedAt: new Date(),
        reviewedBy: openid,
      },
    });
    if (event.approved) {
      const role = ["brother", "sister", "child"].includes(request.relation) ? "child" : "member";
      await transaction.collection("users").doc(applicant._id).update({
        data: { familyId: creator.familyId, relation: request.relation, role },
      });
    }
  });
  return success(null, event.approved ? "已批准加入" : "已拒绝申请");
}

async function getFamily(openid) {
  const user = await requireUser(openid);
  if (!user.familyId) return failure("您尚未加入家庭");
  const familyData = (await db.collection("families").doc(user.familyId).get()).data;
  return success({ family: publicFamily(familyData), currentUser: { _id: user._id, nickname: user.nickname, avatar: user.avatar, familyId: user.familyId, relation: user.relation, role: user.role } });
}

async function members(openid) {
  const user = await requireUser(openid);
  if (!user.familyId) return failure("您尚未加入家庭");
  const result = await db.collection("users").where({ familyId: user.familyId }).limit(50).get();
  return success({
    currentRole: user.role,
    members: result.data.map((item) => ({
      _id: item._id,
      nickname: item.nickname,
      avatar: item.avatar,
      relation: item.relation,
      role: item.role,
      createdAt: item.createdAt,
      relationName: RELATION_NAMES[item.relation] || "成员",
      roleName: item.role === "creator" ? "创建者" : item.role === "child" ? "孩子" : "成员",
    })),
  });
}

async function removeMember(openid, event) {
  const creator = await requireCreator(openid);
  const userId = cleanText(event.userId, 64);
  const target = (await db.collection("users").doc(userId).get()).data;
  if (!target || target.familyId !== creator.familyId || target.role === "creator") {
    return failure("无法移除该成员");
  }
  await db.collection("users").doc(userId).update({
    data: { familyId: "", relation: "", role: "" },
  });
  return success(null, "成员已移除");
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return failure("无法识别当前微信用户");
  try {
    switch (event.action) {
      case "create": return await createFamily(OPENID, event);
      case "searchByInviteCode": return await searchByInviteCode(OPENID, event);
      case "applyJoin": return await applyJoin(OPENID, event);
      case "listRequests": return await listRequests(OPENID);
      case "reviewJoin": return await reviewJoin(OPENID, event);
      case "get": return await getFamily(OPENID);
      case "members": return await members(OPENID);
      case "removeMember": return await removeMember(OPENID, event);
      default: return failure("不支持的操作");
    }
  } catch (error) {
    const known = {
      UNREGISTERED: "请先完成注册",
      FORBIDDEN: "您没有执行此操作的权限",
      CONFLICT: "家庭状态已变化，请刷新后重试",
      INVALID_REQUEST: "申请不存在或已处理",
      APPLICANT_UNAVAILABLE: "申请人已加入其他家庭",
      RATE_LIMIT: "今日邀请码查询次数已达上限，请明天再试",
      INVITE_CODE_UNAVAILABLE: "邀请码生成失败，请稍后重试",
    };
    console.error("Family action failed", { action: event.action, message: error.message, stack: error.stack });
    return failure(known[error.message] || "家庭服务暂时不可用，请稍后重试");
  }
};
