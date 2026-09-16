const { callFunction, showError } = require("../../utils/api");
const { EDUCATION_STAGES, GRADES, RELATIONS, CURRENT_SEMESTER } = require("../../utils/constants");
const { formatDate } = require("../../utils/date");
const { createShareAppMessage, createShareTimelineMessage } = require("../../utils/share");

function showInviteCode(inviteCodeDisplay, inviteCode) {
  return new Promise((resolve) => {
    wx.showModal({
      title: "家庭创建成功",
      content: `家庭邀请码：${inviteCodeDisplay}\n可在设置页再次查看。`,
      confirmText: "复制邀请码",
      cancelText: "稍后分享",
      success(result) {
        if (!result.confirm) {
          resolve();
          return;
        }
        wx.setClipboardData({ data: inviteCode, complete: resolve });
      },
      fail: resolve,
    });
  });
}

const relationEntries = Object.entries(RELATIONS).filter(([value]) => !["brother", "sister", "child"].includes(value));

Page({
  onShareAppMessage: createShareAppMessage,
  onShareTimeline: createShareTimelineMessage,

  data: {
    form: { childName: "", childNickname: "", childBirthday: "", className: "" },
    today: formatDate(new Date()),
    stageLabels: EDUCATION_STAGES.map((item) => item.label),
    stageIndex: 2,
    gradeOptions: GRADES.junior_high,
    gradeIndex: 0,
    relationLabels: relationEntries.map((item) => item[1]),
    relationIndex: 0,
    submitting: false,
  },

  onInput(event) {
    this.setData({ [`form.${event.currentTarget.dataset.field}`]: event.detail.value });
  },

  onBirthdayChange(event) {
    this.setData({ "form.childBirthday": event.detail.value });
  },

  onStageChange(event) {
    const stageIndex = Number(event.detail.value);
    this.setData({ stageIndex, gradeOptions: GRADES[EDUCATION_STAGES[stageIndex].value], gradeIndex: 0 });
  },

  onGradeChange(event) {
    this.setData({ gradeIndex: Number(event.detail.value) });
  },

  onRelationChange(event) {
    this.setData({ relationIndex: Number(event.detail.value) });
  },

  async submit() {
    const { form, stageIndex, gradeOptions, gradeIndex, relationIndex } = this.data;
    if (!form.childName.trim() || !form.childBirthday) {
      wx.showToast({ title: "请填写孩子姓名和生日", icon: "none" });
      return;
    }
    this.setData({ submitting: true });
    try {
      const result = await callFunction("family", "create", {
        ...form,
        educationStage: EDUCATION_STAGES[stageIndex].value,
        grade: gradeOptions[gradeIndex],
        relation: relationEntries[relationIndex][0],
        currentSemester: CURRENT_SEMESTER,
      });
      await showInviteCode(result.inviteCodeDisplay, result.inviteCode);
      wx.switchTab({ url: "/pages/home/home" });
    } catch (error) {
      showError(error, "家庭创建失败");
    } finally {
      this.setData({ submitting: false });
    }
  },
});
