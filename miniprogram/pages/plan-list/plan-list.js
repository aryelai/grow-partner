const { callFunction, showError } = require("../../utils/api");
const { requireFamily } = require("../../utils/session");
const { PLAN_TYPES } = require("../../utils/constants");
const { formatDate, getDateRangeForPlan } = require("../../utils/date");
const { canPerform } = require("../../utils/permissions");

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
  data: { types: PLAN_TYPES, type: "daily", anchorDate: formatDate(new Date()), rangeLabel: "", semester: "2026下", items: [], completionRate: 0, loading: true, canManage: false },
  async onShow() {
    let session;
    try {
      session = await requireFamily();
    } catch (error) {
      this.currentUser = null;
      this.setData({ canManage: false });
      showError(error, "身份校验失败，请稍后重试");
      return;
    }
    if (!session) { this.currentUser = null; this.setData({ canManage: false }); return; }
    this.currentUser = session.user;
    this.setData({ semester: session.family.currentSemester, canManage: canPerform(session.user.role, "managePlan") });
    await this.load();
  },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  async load() {
    this.setData({ loading: true });
    const range = getDateRangeForPlan(this.data.type, this.data.anchorDate);
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
  create() { if (!canPerform(this.currentUser && this.currentUser.role, "managePlan")) { wx.showToast({ title: "孩子账号不能新增或编辑计划", icon: "none" }); return; } wx.navigateTo({ url: `/pages/plan-edit/plan-edit?type=${this.data.type}&date=${this.data.anchorDate}` }); },
  edit(event) { if (!canPerform(this.currentUser && this.currentUser.role, "managePlan")) { wx.showToast({ title: "孩子账号不能新增或编辑计划", icon: "none" }); return; } wx.navigateTo({ url: `/pages/plan-edit/plan-edit?id=${event.currentTarget.dataset.id}` }); },
  async toggleItem(event) { try { await callFunction("plan", "toggleItem", { id: event.currentTarget.dataset.id, itemIndex: Number(event.currentTarget.dataset.index), isDone: event.detail.value }); await this.load(); } catch (error) { showError(error); } },
});
