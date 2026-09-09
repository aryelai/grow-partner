const cloud = require("wx-server-sdk");
const { createReminderService } = require("./service");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const database = cloud.database();
const service = createReminderService({
  database,
  sendSubscribeMessage: (message) => cloud.openapi.subscribeMessage.send(message),
  miniprogramState: process.env.MINIPROGRAM_STATE,
});

const PUBLIC_FAILURES = new Map([
  ["UNAUTHORIZED", "请先登录并加入家庭"],
  ["INVALID_TEMPLATE", "订阅消息模板不正确"],
  ["INVALID_DECISION", "订阅结果不正确"],
  ["INVALID_REQUEST_ID", "订阅请求编号不正确"],
  ["DAILY_LIMIT", "今日订阅登记次数已达上限，请明天再试"],
]);
const CLIENT_ACTIONS = new Set(["getStatus", "recordSubscription"]);

function success(data) { return { success: true, data, message: "" }; }
function failure(message) { return { success: false, data: null, message }; }

async function requireUser(openid) {
  if (typeof openid !== "string" || !openid.trim()) throw new Error("UNAUTHORIZED");
  const result = await database.collection("users").where({ openid }).limit(1).get();
  const user = result.data[0];
  if (!user || user.openid !== openid || !user.familyId || !["creator", "member", "child"].includes(user.role)) {
    throw new Error("UNAUTHORIZED");
  }
  return user;
}

exports.main = async (event = {}) => {
  const action = event && event.action;
  try {
    const context = cloud.getWXContext();
    if (context.SOURCE === "wx_trigger") return success(await service.run());
    const user = await requireUser(context.OPENID);
    if (action === "getStatus") return success(await service.getStatus(user));
    if (action === "recordSubscription") return success(await service.recordSubscription(user, event));
    return failure("不支持的操作");
  } catch (error) {
    const code = error && PUBLIC_FAILURES.has(error.message) ? error.message : "INTERNAL";
    // 日志仅保留受控操作和错误分类，不记录客户端载荷或底层错误正文。
    console.error("Reminder action failed", { action: CLIENT_ACTIONS.has(action) ? action : "unsupported", code });
    return failure(PUBLIC_FAILURES.get(code) || "提醒服务暂时不可用，请稍后重试");
  }
};
