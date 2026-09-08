const { callFunction } = require("./api");

async function loadSession() {
  const data = await callFunction("login", "getProfile");
  const app = getApp();
  app.globalData.user = data.user || null;
  app.globalData.family = data.family || null;
  return data;
}

async function requireFamily() {
  const data = await loadSession();
  if (!data.registered) {
    wx.reLaunch({ url: "/pages/login/login" });
    return null;
  }
  if (!data.user || !data.user.familyId) {
    wx.reLaunch({ url: "/pages/login/login?step=family" });
    return null;
  }
  if (!data.family) {
    wx.showToast({ title: "家庭数据异常，请联系创建者", icon: "none" });
    return null;
  }
  return data;
}

module.exports = { loadSession, requireFamily };
