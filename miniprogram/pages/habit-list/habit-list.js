const { callFunction, showError } = require("../../utils/api");
const { requireFamily } = require("../../utils/session");
const { HABIT_CATEGORIES } = require("../../utils/constants");
const { formatDate, getBeijingDate } = require("../../utils/date");
const { getWeekRange, createWeeklyReview } = require("../../utils/weekly-review");
const { canPerform } = require("../../utils/permissions");
const { createShareAppMessage, createShareTimelineMessage } = require("../../utils/share");
const { GUEST_SEMESTER_LABEL, createGuestHabitItems, requestFamilyAccess } = require("../../utils/guest-experience");

const categoryIcons = { behavior: "check", life: "clock", study: "book" };

Page({
  onShareAppMessage: createShareAppMessage,
  onShareTimeline: createShareTimelineMessage,

  data: { categories: [{ value: "all", label: "全部" }, ...HABIT_CATEGORIES], selectedCategory: "all", semester: "2026下", items: [], loading: true, canManage: false, guestMode: false,
    view: "habit", planEntryDate: "", creating: false, submitting: false, loadFailed: false,
    weeklyReview: null, reviewLoading: false, reviewFailed: false,
    habitTotal: 0, habitDone: 0, longestStreak: 0, habitProgressText: "", planSummary: "日 / 周 / 月计划",
    habitForm: { name: "", category: "behavior", goal: "", targetDays: "21" }, habitCategories: HABIT_CATEGORIES },
  async onShow() {
    const entry = getApp().globalData.growthEntry;
    if (entry && ["habit", "plan", "review"].includes(entry.view)) {
      this.setData({ view: entry.view, planEntryDate: entry.date || "" });
      getApp().globalData.growthEntry = null;
    }
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
    this.setData({ semester: session.family.currentSemester, canManage: canPerform(session.user.role, "manageHabit"), guestMode: false });
    await this.load();
    this.refreshPlan();
    if (this.data.view === "review") await this.loadWeeklyReview();
  },
  enterGuestMode() {
    this.currentUser = null;
    this.setData({ semester: GUEST_SEMESTER_LABEL, canManage: false, guestMode: true });
    this.load();
    this.refreshPlan();
  },
  requestReviewAccess() { requestFamilyAccess("登录并加入家庭后，可查看真实的每周完成数据。", wx); },
  refreshPlan() {
    const panel = typeof this.selectComponent === "function" && this.selectComponent("#growth-plan");
    if (panel) return panel.refresh();
  },
  onPlanSummary(event) {
    const summary = event.detail || {};
    if (summary.isToday !== true || !Number.isInteger(summary.total) || !Number.isInteger(summary.done)
      || summary.done < 0 || summary.total < summary.done) return;
    this.setData({ planSummary: `今日 ${summary.done}/${summary.total} 已完成` });
  },
  selectView(event) {
    if (this.data.submitting) return;
    const view = event.currentTarget.dataset.value;
    if (!["habit", "plan", "review"].includes(view)) return;
    this.setData({ view });
    if (view === "plan") this.refreshPlan();
    if (view === "review") this.loadWeeklyReview();
  },
  onPullDownRefresh() {
    let request;
    if (this.data.view === "plan") request = this.refreshPlan();
    else if (this.data.view === "review") request = this.loadWeeklyReview();
    else request = this.load();
    Promise.resolve(request).finally(() => wx.stopPullDownRefresh());
  },
  async loadWeeklyReview() {
    if (this.data.guestMode || this.data.reviewLoading) return;
    const today = getBeijingDate(new Date());
    const range = getWeekRange(today);
    this.setData({ reviewLoading: true, reviewFailed: false });
    try {
      const [homework, notices, plans] = await Promise.all([
        callFunction("homework", "list", { semester: this.data.semester, start: range.start, end: range.end, status: "all", page: 1, pageSize: 50 }),
        callFunction("notice", "list", { semester: this.data.semester, status: "all", page: 1, pageSize: 50 }),
        callFunction("plan", "list", { semester: this.data.semester, start: range.start, end: range.end, page: 1, pageSize: 50 }),
      ]);
      const weeklyReview = createWeeklyReview({
        today,
        homework: homework.items,
        notices: notices.items,
        plans: plans.items,
        habits: this.allHabitItems,
        incomplete: homework.hasMore === true || homework.truncated === true
          || notices.hasMore === true || notices.truncated === true || plans.hasMore === true,
      });
      this.setData({ weeklyReview });
    } catch (error) {
      this.setData({ reviewFailed: true });
      showError(error, "本周复盘加载失败");
    } finally {
      this.setData({ reviewLoading: false });
    }
  },
  openReviewSource(event) {
    const source = event.currentTarget.dataset.source;
    if (source === "homework") { wx.switchTab({ url: "/pages/homework-list/homework-list" }); return; }
    if (source === "notice") { wx.switchTab({ url: "/pages/notice-list/notice-list" }); return; }
    if (source === "plan") { this.setData({ view: "plan" }); this.refreshPlan(); return; }
    if (source === "habit") this.setData({ view: "habit" });
  },
  async load() {
    const version = this.loadVersion = (this.loadVersion || 0) + 1;
    if (this.data.guestMode) {
      this.applyHabits(createGuestHabitItems("all"));
      this.setData({ loading: false, loadFailed: false });
      return;
    }
    this.allHabitItems = [];
    this.setData({ loading: true, loadFailed: false, items: [], habitTotal: 0, habitDone: 0, longestStreak: 0 });
    try {
      const data = await callFunction("habit", "list", { semester: this.data.semester, category: "all", today: formatDate(new Date()), page: 1, pageSize: 50 });
      if (version !== this.loadVersion) return;
      this.applyHabits(data.items);
    } catch (error) { if (version === this.loadVersion) { this.setData({ loadFailed: true }); showError(error, "习惯加载失败"); } }
    finally { if (version === this.loadVersion) this.setData({ loading: false }); }
  },
  applyHabits(value) {
    this.allHabitItems = (Array.isArray(value) ? value : []).map((item) => ({ ...item,
      categoryIcon: categoryIcons[item.category] || "leaf", completedToday: item.completedToday === true || item.streak > 0,
      checkInSummary: (item.checkInItems || []).map((entry) => entry.name).join(" + ") }));
    const habitTotal = this.allHabitItems.length;
    const habitDone = this.allHabitItems.filter((item) => item.completedToday).length;
    const longestStreak = this.allHabitItems.reduce((longest, item) => Math.max(longest, Number(item.streak) || 0), 0);
    const habitProgressText = !habitTotal ? "从一个小习惯开始，记录每天的成长。"
      : habitDone === habitTotal ? `今天 ${habitTotal} 项习惯全部完成，继续保持。`
      : `今天已完成 ${habitDone} 项，再完成 ${habitTotal - habitDone} 项即可达成。`;
    this.setData({ habitTotal, habitDone, longestStreak, habitProgressText });
    this.filterHabits();
  },
  filterHabits() {
    this.setData({ items: (this.allHabitItems || []).filter((item) => this.data.selectedCategory === "all" || item.category === this.data.selectedCategory) });
  },
  selectCategory(event) {
    const value = event.currentTarget.dataset.value;
    if (!this.data.categories.some((item) => item.value === value)) return;
    this.setData({ selectedCategory: value });
    this.filterHabits();
  },
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
    if (!canPerform(this.currentUser && this.currentUser.role, "manageHabit")) return;
    this.setData({ creating: true, habitForm: { name: "", category: this.data.selectedCategory === "all" ? "behavior" : this.data.selectedCategory, goal: "", targetDays: "21" } });
  },
  cancelCreate() { if (!this.data.submitting) this.setData({ creating: false }); },
  onHabitInput(event) {
    const field = event.currentTarget.dataset.field;
    if (!this.data.submitting && ["name", "goal", "targetDays"].includes(field)) this.setData({ [`habitForm.${field}`]: event.detail.value });
  },
  selectHabitCategory(event) { if (!this.data.submitting && HABIT_CATEGORIES.some((item) => item.value === event.currentTarget.dataset.value)) this.setData({ "habitForm.category": event.currentTarget.dataset.value }); },
  async saveHabit() {
    if (this.data.submitting || !canPerform(this.currentUser && this.currentUser.role, "manageHabit")) return;
    const form = { ...this.data.habitForm };
    const name = form.name.trim();
    const goal = form.goal.trim();
    const targetDays = /^\d{1,3}$/.test(form.targetDays) ? Number(form.targetDays) : 0;
    if (!name || !goal || targetDays < 1 || targetDays > 365) { wx.showToast({ title: "请填写名称、每日目标和1–365天的目标", icon: "none" }); return; }
    this.setData({ submitting: true });
    try {
      const session = await requireFamily({ redirect: false });
      if (!session || !canPerform(session.user.role, "manageHabit") || session.user.familyId !== this.currentUser.familyId) { wx.showToast({ title: "家庭或权限已变化，请重新打开表单", icon: "none" }); return; }
      await callFunction("habit", "create", { name, category: form.category, description: goal, frequency: "daily", targetDays,
        checkInItems: [{ name: goal, required: true }], startDate: formatDate(new Date()), semester: this.data.semester, isActive: true, reward: "" });
      this.setData({ creating: false, selectedCategory: "all" });
      await this.load();
    } catch (error) { showError(error, "习惯创建失败，请重试"); }
    finally { this.setData({ submitting: false }); }
  },
  onUnload() { this.loadVersion = (this.loadVersion || 0) + 1; },
});
