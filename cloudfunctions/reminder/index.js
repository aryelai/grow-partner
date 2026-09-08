const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  if (event.action === "getStatus") return { success: true, data: { enabled: false, scheduled: false }, message: "订阅消息提醒尚未配置" };
  console.info("Reminder placeholder called", { action: event.action, hasUserContext: Boolean(OPENID) });
  return { success: false, data: null, message: "请先配置订阅消息模板与定时触发器" };
};
