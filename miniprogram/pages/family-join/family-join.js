const { callFunction, showError } = require("../../utils/api");
const { RELATIONS } = require("../../utils/constants");
const { isValidInviteCode, normalizeInviteCode } = require("../../utils/invite-code");
const { createShareAppMessage, createShareTimelineMessage } = require("../../utils/share");

const relationEntries = Object.entries(RELATIONS);

Page({
  onShareAppMessage: createShareAppMessage,
  onShareTimeline: createShareTimelineMessage,

  data: {
    inviteCode: "",
    family: null,
    relationLabels: relationEntries.map((item) => item[1]),
    relationIndex: 1,
    searching: false,
    submitting: false,
  },

  onInviteCodeInput(event) { this.setData({ inviteCode: event.detail.value.toUpperCase(), family: null }); },
  onRelationChange(event) { this.setData({ relationIndex: Number(event.detail.value) }); },

  async search() {
    const inviteCode = normalizeInviteCode(this.data.inviteCode);
    if (!isValidInviteCode(inviteCode)) {
      wx.showToast({ title: "请输入正确的8位家庭邀请码", icon: "none" });
      return;
    }
    this.setData({ searching: true });
    try {
      const family = await callFunction("family", "searchByInviteCode", { inviteCode });
      this.setData({ family, inviteCode });
    } catch (error) {
      showError(error, "未找到可加入的家庭");
    } finally {
      this.setData({ searching: false });
    }
  },

  async apply() {
    this.setData({ submitting: true });
    try {
      await callFunction("family", "applyJoin", {
        familyId: this.data.family._id,
        inviteCode: normalizeInviteCode(this.data.inviteCode),
        relation: relationEntries[this.data.relationIndex][0],
      });
      wx.showToast({ title: "申请已提交", icon: "success" });
      setTimeout(() => wx.reLaunch({ url: "/pages/login/login?step=family" }), 800);
    } catch (error) {
      showError(error, "申请提交失败");
    } finally {
      this.setData({ submitting: false });
    }
  },
});
