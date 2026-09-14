const { callFunction, showError } = require("../../utils/api");
const { requireFamily } = require("../../utils/session");
const { PLAN_TYPES } = require("../../utils/constants");
const { formatDate, getDateRangeForPlan } = require("../../utils/date");
const { canPerform } = require("../../utils/permissions");
const { createShareAppMessage, createShareTimelineMessage } = require("../../utils/share");
const { GUEST_SEMESTER_LABEL, createGuestPlanState, requestFamilyAccess } = require("../../utils/guest-experience");

function shiftAnchor(value, type, offset) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (type === "daily") date.setDate(date.getDate() + offset);
  if (type === "weekly") date.setDate(date.getDate() + offset * 7);
  if (type === "monthly") date.setMonth(date.getMonth() + offset);
  return formatDate(date);
}

function labelRange(type, range) {
  if (type === "daily") return range.start;
  if (type === "weekly") return `${range.start} 至 ${range.end}`;
  return range.start.slice(0, 7);
}

Page({
  onShareAppMessage: createShareAppMessage,
  onShareTimeline: createShareTimelineMessage,

  data: { types: PLAN_TYPES, type: "daily", anchorDate: formatDate(new Date()), rangeLabel: "", semester: "2026下", items: [], completionRate: 0, loading: true, canManage: false, guestMode: false },
  async onShow() {
    let session;
    try {
      session = await requireFamily({ redirect: false });
    } catch (error) {
      console.error("Load plan session failed", { message: error.message });
      this.enterGuestMode();
      showError(error, "身份校验失败，请稍后重试");
      return;
    }
    if (!session) { this.enterGuestMode(); return; }
    this.currentUser = session.user;
    this.setData({ semester: session.family.currentSemester, canManage: canPerform(session.user.role, "managePlan"), guestMode: false });
    await this.load();
  },
  enterGuestMode() {
    this.currentUser = null;
    this.setData({ semester: GUEST_SEMESTER_LABEL, type: "daily", anchorDate: formatDate(new Date()), canManage: false, guestMode: true });
    this.load();
  },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  async load() {
    const range = getDateRangeForPlan(this.data.type, this.data.anchorDate);
    if (this.data.guestMode) {
      const state = createGuestPlanState(this.data.type, this.data.anchorDate);
      this.setData({ items: state.items, rangeLabel: labelRange(this.data.type, range), completionRate: state.completionRate, loading: false });
      return;
    }
    this.setData({ loading: true });
    try {
      const data = await callFunction("plan", "list", { type: this.data.type, semester: this.data.semester, start: range.start, end: range.end, page: 1, pageSize: 50 });
      const allItems = data.items.flatMap((plan) => plan.items || []);
      const doneCount = allItems.filter((item) => item.isDone).length;
      this.setData({ items: data.items.map((item) => ({ ...item, items: item.items || [] })), rangeLabel: labelRange(this.data.type, range), completionRate: allItems.length ? Math.round(doneCount * 100 / allItems.length) : 0 });
    } catch (error) { showError(error, "计划加载失败"); }
    finally { this.setData({ loading: false }); }
  },
  selectType(event) { this.setData({ type: event.currentTarget.dataset.value }); this.load(); },
  shiftDate(event) { this.setData({ anchorDate: shiftAnchor(this.data.anchorDate, this.data.type, Number(event.currentTarget.dataset.offset)) }); this.load(); },
  create() {
    if (this.data.guestMode) { requestFamilyAccess("登录后可创建计划并同步家庭执行进度。", wx); return; }
    if (!canPerform(this.currentUser && this.currentUser.role, "managePlan")) { wx.showToast({ title: "孩子账号不能新增或编辑计划", icon: "none" }); return; }
    wx.navigateTo({ url: `/pages/plan-edit/plan-edit?type=${this.data.type}&date=${this.data.anchorDate}` });
  },
  edit(event) {
    if (this.data.guestMode) {
      const item = this.data.items.find((candidate) => candidate._id === event.currentTarget.dataset.id);
      if (!item) return;
      wx.showModal({ title: item.title, content: `这里展示${this.data.type === "daily" ? "每日" : this.data.type === "weekly" ? "每周" : "每月"}计划的任务与完成状态。登录后可新增和编辑。`, showCancel: false, confirmText: "知道了" });
      return;
    }
    if (!canPerform(this.currentUser && this.currentUser.role, "managePlan")) { wx.showToast({ title: "孩子账号不能新增或编辑计划", icon: "none" }); return; }
    wx.navigateTo({ url: `/pages/plan-edit/plan-edit?id=${event.currentTarget.dataset.id}` });
  },
  async toggleItem(event) {
    if (this.data.guestMode) {
      const planId = event.currentTarget.dataset.id;
      const itemIndex = Number(event.currentTarget.dataset.index);
      const items = this.data.items.map((plan) => plan._id === planId
        ? { ...plan, items: plan.items.map((item, index) => index === itemIndex ? { ...item, isDone: event.detail.value } : item) }
        : plan);
      const allItems = items.flatMap((plan) => plan.items || []);
      const doneCount = allItems.filter((item) => item.isDone).length;
      this.setData({ items, completionRate: allItems.length ? Math.round(doneCount * 100 / allItems.length) : 0 });
      return;
    }
    try { await callFunction("plan", "toggleItem", { id: event.currentTarget.dataset.id, itemIndex: Number(event.currentTarget.dataset.index), isDone: event.detail.value }); await this.load(); }
    catch (error) { showError(error); }
  },
});
