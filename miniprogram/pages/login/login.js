const { callFunction, showError } = require("../../utils/api");
const { isValidInviteCode, normalizeInviteCode } = require("../../utils/invite-code");

const REGISTRATION_MODES = new Set(["open", "family_invite", "closed"]);

function normalizeRegistrationMode(value) {
  return REGISTRATION_MODES.has(value) ? value : "closed";
}

Page({
  data: {
    loading: true,
    submitting: false,
    registered: false,
    hasFamily: false,
    pending: false,
    nickname: "",
    avatar: "",
    inviteCode: "",
    registrationMode: "closed",
    canCreateFamily: false,
    loadFailed: false,
  },

  async onLoad() {
    await this.refreshProfile();
  },

  async refreshProfile() {
    this.setData({ loading: true, loadFailed: false });
    try {
      const data = await callFunction("login", "getProfile");
      if (data.registered && data.user && data.user.familyId && data.family) {
        getApp().globalData.user = data.user;
        getApp().globalData.family = data.family;
        wx.switchTab({ url: "/pages/homework-list/homework-list" });
        return;
      }
      const registrationMode = normalizeRegistrationMode(data.registrationMode);
      this.setData({
        registered: data.registered,
        hasFamily: Boolean(data.family),
        pending: Boolean(data.pendingJoinRequest),
        nickname: data.user ? data.user.nickname : "",
        avatar: data.user ? data.user.avatar : "",
        registrationMode,
        canCreateFamily: registrationMode === "open",
      });
    } catch (error) {
      this.setData({ loadFailed: true });
      showError(error, "登录状态加载失败");
    } finally {
      this.setData({ loading: false });
    }
  },

  retryProfile() {
    return this.refreshProfile();
  },

  onNicknameInput(event) {
    this.setData({ nickname: event.detail.value });
  },

  onInviteCodeInput(event) {
    this.setData({ inviteCode: event.detail.value.toUpperCase() });
  },

  async register() {
    if (this.data.registrationMode === "closed") {
      wx.showToast({ title: "家庭内测暂未开放注册", icon: "none" });
      return;
    }
    if (!this.data.nickname.trim()) {
      wx.showToast({ title: "请先填写昵称", icon: "none" });
      return;
    }
    const inviteCode = normalizeInviteCode(this.data.inviteCode);
    if (this.data.registrationMode === "family_invite" && !isValidInviteCode(inviteCode)) {
      wx.showToast({ title: "请输入正确的8位家庭邀请码", icon: "none" });
      return;
    }

    this.setData({ submitting: true });
    try {
      await callFunction("login", "register", {
        nickname: this.data.nickname,
        avatar: this.data.avatar.startsWith("cloud://") ? this.data.avatar : "",
        ...(this.data.registrationMode === "family_invite" ? { inviteCode } : {}),
      });
      await this.refreshProfile();
    } catch (error) {
      showError(error, "注册失败");
    } finally {
      this.setData({ submitting: false });
    }
  },

  goCreateFamily() {
    if (!this.data.canCreateFamily) {
      wx.showToast({ title: "家庭内测期间暂不支持创建新家庭", icon: "none" });
      return;
    }
    wx.navigateTo({ url: "/pages/family-create/family-create" });
  },

  goJoinFamily() {
    wx.navigateTo({ url: "/pages/family-join/family-join" });
  },
});
