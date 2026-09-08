const { callFunction } = require("./utils/api");

App({
  globalData: {
    user: null,
    family: null,
  },

  onLaunch() {
    if (!wx.cloud) {
      console.error("Cloud capability is unavailable");
      return;
    }
    wx.cloud.init({ traceUser: true });
    this.restoreSession();
  },

  async restoreSession() {
    try {
      const data = await callFunction("login", "getProfile");
      this.globalData.user = data.user;
      this.globalData.family = data.family;
    } catch (error) {
      console.error("Restore session failed", { message: error.message });
    }
  },
});
