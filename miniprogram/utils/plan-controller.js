const { PLAN_TYPES } = require("./constants");
const { formatDate, getDateRangeForPlan } = require("./date");
const { validateIsoDate } = require("./validation");
const { canPerform } = require("./permissions");
const { GUEST_SEMESTER_LABEL, createGuestPlanState, requestFamilyAccess } = require("./guest-experience");

function shiftPlanDate(value, type, offset) {
  if (!validateIsoDate(value) || !Number.isInteger(offset) || ![-1, 1].includes(offset)) return value;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (type === "daily") date.setDate(date.getDate() + offset);
  if (type === "weekly") date.setDate(date.getDate() + offset * 7);
  // 月视图以月初为锚点，避免一月三十一日跨月时跳过二月。
  if (type === "monthly") { date.setDate(1); date.setMonth(date.getMonth() + offset); }
  return formatDate(date);
}

function createPlanData() {
  return { types: PLAN_TYPES, type: "daily", anchorDate: formatDate(new Date()), rangeLabel: "", semester: "2026下",
    items: [], completionRate: 0, totalTasks: 0, doneTasks: 0, loading: true, loadFailed: false,
    canManage: false, canCreate: false, guestMode: false, toggleBusy: false, isCurrentPeriod: true };
}

function progressData(items) {
  const tasks = items.flatMap((plan) => Array.isArray(plan.items) ? plan.items : []);
  const done = tasks.filter((task) => task.isDone === true).length;
  return { items, totalTasks: tasks.length, doneTasks: done, completionRate: tasks.length ? Math.round(done * 100 / tasks.length) : 0 };
}

function createPlanController({ requireFamily, callFunction, showError, wxApi }) {
  return {
    async refresh() {
      try {
        const session = await requireFamily({ redirect: false });
        if (!session) return this.enterGuestMode();
        this.currentUser = session.user;
        this.setData({ semester: session.family.currentSemester, canManage: canPerform(session.user.role, "managePlan"), canCreate: canPerform(session.user.role, "createOwnPlan"), guestMode: false });
        return this.load();
      } catch (error) {
        this.enterGuestMode();
        showError(error, "身份校验失败，请稍后重试");
      }
    },
    enterGuestMode() {
      this.currentUser = null;
      this.setData({ semester: GUEST_SEMESTER_LABEL, canManage: false, canCreate: false, guestMode: true });
      return this.load();
    },
    async load() {
      const version = this.loadVersion = (this.loadVersion || 0) + 1;
      const range = getDateRangeForPlan(this.data.type, this.data.anchorDate);
      const rangeLabel = this.data.type === "weekly" ? `${range.start} 至 ${range.end}` : this.data.type === "monthly" ? range.start.slice(0, 7) : range.start;
      this.setData({ isCurrentPeriod: range.start === getDateRangeForPlan(this.data.type, formatDate(new Date())).start });
      if (this.data.guestMode) {
        const key = `${this.data.type}:${range.start}`;
        if (!this.guestPlanStates) this.guestPlanStates = Object.create(null);
        if (!this.guestPlanStates[key]) this.guestPlanStates[key] = createGuestPlanState(this.data.type, this.data.anchorDate).items;
        this.setData({ ...progressData(this.guestPlanStates[key]), rangeLabel, loading: false, loadFailed: false });
        return;
      }
      this.setData({ loading: true, loadFailed: false, rangeLabel, items: [], totalTasks: 0, doneTasks: 0, completionRate: 0 });
      try {
        const result = await callFunction("plan", "list", { type: this.data.type, semester: this.data.semester, start: range.start, end: range.end, page: 1, pageSize: 50 });
        if (version !== this.loadVersion) return;
        const items = result.items.map((plan) => ({ ...plan, canEdit: plan.canEdit === true || this.data.canManage, items: Array.isArray(plan.items) ? plan.items : [] }));
        this.setData(progressData(items));
      } catch (error) {
        if (version !== this.loadVersion) return;
        this.setData({ loadFailed: true });
        showError(error, "计划加载失败");
      } finally { if (version === this.loadVersion) this.setData({ loading: false }); }
    },
    selectType(event) {
      if (this.data.toggleBusy) return;
      const type = event.currentTarget.dataset.value;
      if (!PLAN_TYPES.some((item) => item.value === type)) return;
      this.setData({ type });
      return this.load();
    },
    shiftDate(event) {
      if (this.data.toggleBusy) return;
      this.setData({ anchorDate: shiftPlanDate(this.data.anchorDate, this.data.type, Number(event.currentTarget.dataset.offset)) });
      return this.load();
    },
    goToday() { if (this.data.toggleBusy) return; this.setData({ type: "daily", anchorDate: formatDate(new Date()) }); return this.load(); },
    create() {
      if (this.data.guestMode) { requestFamilyAccess("登录后可创建计划并同步家庭执行进度。", wxApi); return; }
      if (!canPerform(this.currentUser && this.currentUser.role, "createOwnPlan")) return;
      wxApi.navigateTo({ url: `/pages/plan-edit/plan-edit?type=${this.data.type}&date=${this.data.anchorDate}` });
    },
    edit(event) {
      const item = this.data.items.find((plan) => plan._id === event.currentTarget.dataset.id);
      if (!item) return;
      if (this.data.guestMode) { wxApi.showModal({ title: item.title, content: "这是演示计划，登录后可新增和编辑。", showCancel: false, confirmText: "知道了" }); return; }
      if (!item.canEdit) return;
      wxApi.navigateTo({ url: `/pages/plan-edit/plan-edit?id=${item._id}` });
    },
    toggleTask(event) {
      const id = event.currentTarget.dataset.id;
      const index = Number(event.currentTarget.dataset.index);
      const plan = this.data.items.find((item) => item._id === id);
      if (!plan || !Number.isInteger(index) || index < 0 || index >= plan.items.length) return;
      return this.toggleItem({ currentTarget: { dataset: { id, index } }, detail: { value: plan.items[index].isDone !== true } });
    },
    async toggleItem(event) {
      if (this.data.toggleBusy || this.data.loading) return;
      const id = event.currentTarget.dataset.id;
      const index = Number(event.currentTarget.dataset.index);
      const isDone = event.detail.value;
      const plan = this.data.items.find((item) => item._id === id);
      if (!plan || !Number.isInteger(index) || index < 0 || index >= plan.items.length || typeof isDone !== "boolean") return;
      if (!this.data.guestMode && !canPerform(this.currentUser && this.currentUser.role, "togglePlan")) return;
      this.setData({ toggleBusy: true });
      try {
        if (!this.data.guestMode) await callFunction("plan", "toggleItem", { id, itemIndex: index, isDone });
        const items = this.data.items.map((item) => item._id === id ? { ...item, items: item.items.map((task, taskIndex) => taskIndex === index ? { ...task, isDone } : task) } : item);
        if (this.data.guestMode) this.guestPlanStates[`${this.data.type}:${getDateRangeForPlan(this.data.type, this.data.anchorDate).start}`] = items;
        this.setData(progressData(items));
      } catch (error) {
        // 开关原生值先于请求改变，重新提交公开状态使失败界面恢复原值。
        this.setData({ items: this.data.items.map((item) => ({ ...item, items: item.items.map((task) => ({ ...task })) })) });
        showError(error, "任务状态更新失败，请重试");
      } finally { this.setData({ toggleBusy: false }); }
    },
  };
}

module.exports = { createPlanController, createPlanData, shiftPlanDate };
