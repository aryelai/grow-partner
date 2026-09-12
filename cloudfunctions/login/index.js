const cloud = require("wx-server-sdk");
const { validateProfile } = require("./profile");
const {
  createRegistrationAttemptId,
  getRegistrationMode,
  isValidInviteCode,
  normalizeInviteCode,
} = require("./registration");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const REGISTRATION_ATTEMPT_LIMIT = 20;
const REGISTRATION_DENIED_MESSAGE = "暂时无法完成注册，请检查家庭邀请码后重试";

function success(data, message = "") {
  return { success: true, data, message };
}

function failure(message) {
  return { success: false, data: null, message };
}

function isDuplicateWriteError(error) {
  const errorCode = String(error.code || error.errCode || "");
  const errorMessage = String(error.errMsg || error.message || "");
  return errorCode === "DATABASE_DUPLICATE_WRITE" || /duplicate(?:\s+key|\s+write)?/i.test(errorMessage);
}

async function findUser(openid) {
  const result = await db.collection("users").where({ openid }).limit(1).get();
  return result.data[0] || null;
}

function publicUser(user) {
  if (!user) return null;
  return {
    _id: user._id,
    nickname: user.nickname,
    avatar: user.avatar,
    familyId: user.familyId,
    relation: user.relation,
    role: user.role,
  };
}

function publicFamily(family) {
  if (!family) return null;
  const { creatorOpenid, inviteCode, ...safeFamily } = family;
  return safeFamily;
}

async function getProfile(openid) {
  const registrationMode = getRegistrationMode(process.env.REGISTRATION_MODE);
  const user = await findUser(openid);
  if (!user) {
    return success({ registered: false, user: null, family: null, pendingJoinRequest: null, registrationMode });
  }

  let family = null;
  if (user.familyId) {
    try {
      family = (await db.collection("families").doc(user.familyId).get()).data;
    } catch (error) {
      console.error("Family lookup failed", { message: error.message });
      if (!String(error.errMsg || error.message).includes("exist")) throw error;
    }
  }
  const pendingResult = await db.collection("family_join_requests")
    .where({ applicantOpenid: openid, status: "pending" })
    .limit(1)
    .get();

  return success({
    registered: true,
    user: publicUser(user),
    family: publicFamily(family),
    pendingJoinRequest: pendingResult.data[0] ? {
      _id: pendingResult.data[0]._id,
      familyId: pendingResult.data[0].familyId,
      relation: pendingResult.data[0].relation,
      status: pendingResult.data[0].status,
      createdAt: pendingResult.data[0].createdAt,
    } : null,
    registrationMode,
  });
}

function isMissingDocumentError(error) {
  const errorCode = String(error.code || error.errCode || "");
  const errorMessage = String(error.errMsg || error.message || "");
  return errorCode === "DOCUMENT_NOT_FOUND" || /(?:document.*(?:does not exist|not found)|not exist)/i.test(errorMessage);
}

async function consumeRegistrationAttempt(openid) {
  const date = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const documentId = createRegistrationAttemptId(openid, date);
  return db.runTransaction(async (transaction) => {
    let current = null;
    try {
      current = (await transaction.collection("family_search_limits").doc(documentId).get()).data;
    } catch (error) {
      if (!isMissingDocumentError(error)) throw error;
    }
    if (current && current.count >= REGISTRATION_ATTEMPT_LIMIT) return false;
    await transaction.collection("family_search_limits").doc(documentId).set({
      data: {
        openid,
        date,
        count: (current ? current.count : 0) + 1,
        purpose: "registration_invite",
        updatedAt: new Date(),
      },
    });
    return true;
  });
}

async function canRegisterWithInvite(openid, value) {
  const inviteCode = normalizeInviteCode(value);
  if (!isValidInviteCode(inviteCode)) return false;
  if (!await consumeRegistrationAttempt(openid)) return false;
  const result = await db.collection("families").where({ inviteCode }).limit(1).get();
  return result.data.length > 0;
}

async function register(openid, event) {
  const profile = validateProfile(event);
  if (!profile.valid) return failure(profile.message);
  const { nickname, avatar } = profile.data;
  const currentUser = await findUser(openid);
  const now = new Date();
  if (currentUser) {
    await db.collection("users").doc(currentUser._id).update({
      data: { nickname, avatar, lastLoginAt: now },
    });
  } else {
    const registrationMode = getRegistrationMode(process.env.REGISTRATION_MODE);
    if (registrationMode === "closed") return failure(REGISTRATION_DENIED_MESSAGE);
    if (registrationMode === "family_invite" && !await canRegisterWithInvite(openid, event.inviteCode)) {
      return failure(REGISTRATION_DENIED_MESSAGE);
    }
    try {
      await db.collection("users").add({
        data: {
          openid,
          nickname,
          avatar,
          familyId: "",
          relation: "",
          role: "",
          createdAt: now,
          lastLoginAt: now,
        },
      });
    } catch (error) {
      if (!isDuplicateWriteError(error)) throw error;
      const concurrentUser = await findUser(openid);
      if (!concurrentUser) throw error;
      await db.collection("users").doc(concurrentUser._id).update({
        data: { nickname, avatar, lastLoginAt: now },
      });
    }
  }
  return success({ nickname, avatar }, "注册成功");
}

async function updateProfile(openid, event) {
  const user = await findUser(openid);
  if (!user) return failure("请先完成注册");
  const profile = validateProfile(event);
  if (!profile.valid) return failure(profile.message);
  const { nickname, avatar } = profile.data;
  await db.collection("users").doc(user._id).update({ data: { nickname, avatar } });
  return success({ nickname, avatar }, "资料已更新");
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return failure("无法识别当前微信用户");

  try {
    switch (event.action) {
      case "getProfile":
        return await getProfile(OPENID);
      case "register":
        return await register(OPENID, event);
      case "updateProfile":
        return await updateProfile(OPENID, event);
      default:
        return failure("不支持的操作");
    }
  } catch (error) {
    console.error("Login action failed", { action: event.action, message: error.message, stack: error.stack });
    return failure("登录服务暂时不可用，请稍后重试");
  }
};
