const { callFunction, showError } = require("../../utils/api");
const { requireFamily } = require("../../utils/session");
const { HABIT_CATEGORIES } = require("../../utils/constants");
const { formatDate } = require("../../utils/date");
const { createShareAppMessage, createShareTimelineMessage } = require("../../utils/share");
const { GUEST_SEMESTER_LABEL, createGuestHabitItems, requestFamilyAccess } = require("../../utils/guest-experience");

const categoryIcons = { behavior: "行", life: "生", study: "学" };

Page({
  onShareAppMessage: createShareAppMessage,
  onShareTimeline: createShareTimelineMessage,

  data: { categories: HABIT_CATEGORIES, selectedCategory: "behavior", semester: "2026下", items: [], loading: true, canManage: false, guestMode: false },
  async onShow() {
    let session;
    try {
      session = await requireFamily({ redirect: false });
    } catch (error) {
      console.error("Load habit session failed", { message: error.message });
      this.enterGuestMode();
      showError(error, "身份校验失败，请稍后重试");
      return;
    }
    if (!session) { this.enterGuestMode(); return; }
    this.currentUser = session.user;
    this.setData({ semester: session.family.currentSemester, canManage: session.user.role !== "child", guestMode: false });
    await this.load();
  },
  enterGuestMode() {
    this.currentUser = null;
    this.setData({ semester: GUEST_SEMESTER_LABEL, selectedCategory: "behavior", canManage: false, guestMode: true });
    this.load();
  },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  async load() {
    if (this.data.guestMode) {
      this.setData({ items: createGuestHabitItems(this.data.selectedCategory), loading: false });
      return;
    }
    this.setData({ loading: true });
    try {
      const data = await callFunction("habit", "list", { semester: this.data.semester, category: this.data.selectedCategory, today: formatDate(new Date()), page: 1, pageSize: 50 });
      this.setData({ items: data.items.map((item) => ({ ...item, categoryIcon: categoryIcons[item.category], checkInSummary: (item.checkInItems || []).map((entry) => entry.name).join(" + ") })) });
    } catch (error) { showError(error, "习惯加载失败"); }
    finally { this.setData({ loading: false }); }
  },
  selectCategory(event) { this.setData({ selectedCategory: event.currentTarget.dataset.value }); this.load(); },
  openDetail(event) {
    if (this.data.guestMode) {
      const item = this.data.items.find((candidate) => candidate._id === event.currentTarget.dataset.id);
      if (!item) return;
      wx.showModal({ title: item.name, content: `${item.description || item.checkInSummary}\n\n当前进度：${item.completedDays}/${item.targetDays} 天`, showCancel: false, confirmText: "知道了" });
      return;
    }
    wx.navigateTo({ url: `/pages/habit-detail/habit-detail?id=${event.currentTarget.dataset.id}` });
  },
  create() {
    if (this.data.guestMode) { requestFamilyAccess("登录后可创建习惯并记录家庭打卡进度。", wx); return; }
    if (this.currentUser && this.currentUser.role === "child") { wx.showToast({ title: "孩子账号不能创建习惯", icon: "none" }); return; }
    wx.showModal({ title: "添加习惯", editable: true, placeholderText: "例如：驼背矫正", success: async (result) => {
      const name = (result.content || "").trim(); if (!result.confirm || !name) return;
      const posture = name.includes("驼背");
      const checkInItems = posture ? [{ name: "靠墙站立5分钟", required: true }, { name: "坐姿保持提醒", required: false }, { name: "背部拉伸操3组", required: true }] : [{ name: "完成今日目标", required: true }];
      try { await callFunction("habit", "create", { name, category: this.data.selectedCategory, description: "", frequency: "daily", targetDays: posture ? 30 : 21, checkInItems, startDate: formatDate(new Date()), semester: this.data.semester, isActive: true, reward: "" }); await this.load(); }
      catch (error) { showError(error, "习惯创建失败"); }
    } });
  },
});
