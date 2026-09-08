const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { success: false, data: null, message: "无法识别当前微信用户" };
  if (event.action === "getStatus") return { success: true, data: { enabled: false, keyConfigured: false }, message: "AI 能力尚未启用" };
  console.info("AI placeholder called", { action: event.action, hasUserContext: true });
  return { success: false, data: null, message: "AI 能力为基础版占位，配置服务端密钥后方可启用" };
};
