const { callFunction, showError, uploadFile } = require("../../utils/api");

Page({
  data: {
    loading: true,
    submitting: false,
    registered: false,
    hasFamily: false,
    pending: false,
    nickname: "",
    avatar: "",
  },

  async onLoad() {
    await this.refreshProfile();
  },

  async refreshProfile() {
    try {
      const data = await callFunction("login", "getProfile");
      if (data.registered && data.user && data.user.familyId && data.family) {
        getApp().globalData.user = data.user;
        getApp().globalData.family = data.family;
        wx.switchTab({ url: "/pages/homework-list/homework-list" });
        return;
      }
      this.setData({
        registered: data.registered,
        hasFamily: Boolean(data.family),
        pending: Boolean(data.pendingJoinRequest),
        nickname: data.user ? data.user.nickname : "",
        avatar: data.user ? data.user.avatar : "",
      });
    } catch (error) {
      showError(error, "登录状态加载失败");
    } finally {
      this.setData({ loading: false });
    }
  },

  onChooseAvatar(event) {
    this.setData({ avatar: event.detail.avatarUrl || "" });
  },

  onNicknameInput(event) {
    this.setData({ nickname: event.detail.value });
  },

  async register() {
    if (!this.data.nickname.trim()) {
      wx.showToast({ title: "请先填写昵称", icon: "none" });
      return;
    }

    this.setData({ submitting: true });
    try {
      let avatar = this.data.avatar;
      if (avatar && !avatar.startsWith("cloud://")) {
        avatar = await uploadFile(`avatars/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.jpg`, avatar);
      }
      await callFunction("login", "register", {
        nickname: this.data.nickname,
        avatar,
      });
      await this.refreshProfile();
    } catch (error) {
      showError(error, "注册失败");
    } finally {
      this.setData({ submitting: false });
    }
  },

  goCreateFamily() {
    wx.navigateTo({ url: "/pages/family-create/family-create" });
  },

  goJoinFamily() {
    wx.navigateTo({ url: "/pages/family-join/family-join" });
  },
});
