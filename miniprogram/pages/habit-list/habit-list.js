const { callFunction, showError } = require("../../utils/api");
const { requireFamily } = require("../../utils/session");
const { HABIT_CATEGORIES } = require("../../utils/constants");
const { formatDate } = require("../../utils/date");
const { createShareAppMessage, createShareTimelineMessage } = require("../../utils/share");

const categoryIcons = { behavior: "行", life: "生", study: "学" };

Page({
  onShareAppMessage: createShareAppMessage,
  onShareTimeline: createShareTimelineMessage,

  data: { categories: HABIT_CATEGORIES, selectedCategory: "behavior", semester: "2026下", items: [], loading: true },
  async onShow() { const session = await requireFamily(); if (!session) return; this.currentUser = session.user; this.setData({ semester: session.family.currentSemester }); await this.load(); },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  async load() { this.setData({ loading: true }); try { const data = await callFunction("habit", "list", { semester: this.data.semester, category: this.data.selectedCategory, today: formatDate(new Date()), page: 1, pageSize: 50 }); this.setData({ items: data.items.map((item) => ({ ...item, categoryIcon: categoryIcons[item.category], checkInSummary: (item.checkInItems || []).map((entry) => entry.name).join(" + ") })) }); } catch (error) { showError(error, "习惯加载失败"); } finally { this.setData({ loading: false }); } },
  selectCategory(event) { this.setData({ selectedCategory: event.currentTarget.dataset.value }); this.load(); },
  openDetail(event) { wx.navigateTo({ url: `/pages/habit-detail/habit-detail?id=${event.currentTarget.dataset.id}` }); },
  create() {
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
