const { callFunction, showError } = require("../../utils/api");
const { requireFamily } = require("../../utils/session");
const { formatHomeworkDate } = require("../../utils/date");
const { decorateNotice } = require("../../utils/notice");
const { createListCompletion } = require("../../utils/list-completion");
const { canPerform } = require("../../utils/permissions");
const { createShareAppMessage, createShareTimelineMessage } = require("../../utils/share");
const {
  createGuestHomeworkItems,
  createGuestNoticeItems,
  createGuestHabitItems,
  createGuestPlanState,
  createGuestTimetableEntries,
  GUEST_SEMESTER_LABEL,
  requestFamilyAccess,
} = require("../../utils/guest-experience");
const {
  createHomeDateContext,
  createScheduleOverview,
  createPlanOverview,
  createHabitOverview,
} = require("../../utils/home");

function decorateHomework(items) {
  return (Array.isArray(items) ? items : []).slice(0, 3).map((item) => ({
    ...item,
    homeworkDateText: formatHomeworkDate(item.homeworkDate),
  }));
}

function decorateNotices(items) {
  return (Array.isArray(items) ? items : []).slice(0, 2).map(decorateNotice);
}

const completion = createListCompletion({ kind: "homework", permission: "toggleHomework", callFunction, showError,
  itemKey: "homeworkItems", reload() { return this.onShow(); } });

async function loadSection(name, request, fallback) {
  try {
    return { value: await request, failed: false };
  } catch (error) {
    console.error("Load home section failed", { section: name, message: error.message });
    return { value: fallback, failed: true };
  }
}

Page({
  onShareAppMessage: createShareAppMessage,
  onShareTimeline: createShareTimelineMessage,

  data: {
    greeting: "你好",
    childName: "",
    semester: "",
    dateLabel: "",
    weekdayLabel: "",
    homeworkItems: [],
    pendingHomeworkCount: 0,
    noticeItems: [],
    importantNoticeCount: 0,
    schedule: { hasEntries: false, total: 0, sessions: [], focus: null, following: [], stateText: "课程表加载中" },
    completionBusy: false,
    undoId: "",
    completionText: "",
    plan: { total: 0, done: 0, percentage: 0, pendingText: "" },
    habits: { total: 0, done: 0, items: [] },
    loading: true,
    partialFailure: false,
    guestMode: false,
    canManageHomework: false,
    canImportHomework: false,
    canManageNotice: false,
    canImportNotice: false,
    canManagePlan: false,
  },

  async onShow() {
    const dateContext = createHomeDateContext();
    this.setData({
      greeting: dateContext.greeting,
      dateLabel: dateContext.dateLabel,
      weekdayLabel: dateContext.weekdayLabel,
      loading: true,
      partialFailure: false,
    });

    let session;
    try {
      session = await requireFamily({ redirect: false });
    } catch (error) {
      console.error("Load home session failed", { message: error.message });
      this.enterGuestMode(dateContext);
      showError(error, "身份校验失败，已进入功能演示");
      return;
    }
    if (!session) {
      this.enterGuestMode(dateContext);
      return;
    }
    await this.loadFamilyDashboard(session, dateContext);
  },

  enterGuestMode(dateContext) {
    this.currentUser = null;
    const homeworkItems = decorateHomework(createGuestHomeworkItems({ status: "pending" }));
    const notices = createGuestNoticeItems({ status: "pending" });
    const planState = createGuestPlanState("daily", dateContext.date);
    const habits = ["behavior", "life", "study"].flatMap((category) => createGuestHabitItems(category));
    this.setData({
      childName: "同学",
      semester: GUEST_SEMESTER_LABEL,
      homeworkItems,
      pendingHomeworkCount: homeworkItems.length,
      noticeItems: decorateNotices(notices),
      importantNoticeCount: notices.length,
      schedule: createScheduleOverview(createGuestTimetableEntries()),
      plan: createPlanOverview(planState.items),
      habits: createHabitOverview(habits),
      loading: false,
      partialFailure: false,
      guestMode: true,
      canManageHomework: false,
      canImportHomework: false,
      canManageNotice: false,
      canImportNotice: false,
      canManagePlan: false,
    });
  },

  async loadFamilyDashboard(session, dateContext) {
    this.currentUser = session.user;
    const semester = session.family.currentSemester;
    const requests = await Promise.all([
      loadSection("homework", callFunction("homework", "list", { semester, subject: "全部", status: "pending", keyword: "", page: 1, pageSize: 3 }), { items: [], total: 0 }),
      loadSection("notice", callFunction("notice", "list", { semester, category: "all", status: "pending", keyword: "", page: 1, pageSize: 2 }), { items: [], total: 0 }),
      loadSection("habit", callFunction("habit", "list", { semester, today: dateContext.date, page: 1, pageSize: 50 }), { items: [], total: 0 }),
      loadSection("plan", callFunction("plan", "list", { type: "daily", semester, start: dateContext.date, end: dateContext.date, page: 1, pageSize: 20 }), { items: [] }),
      loadSection("timetable", callFunction("timetable", "get"), { entries: [] }),
    ]);
    const [homework, notices, habits, plans, timetable] = requests.map((result) => result.value);
    this.setData({
      childName: session.family.childNickname || session.family.childName || "同学",
      semester,
      homeworkItems: decorateHomework(homework.items),
      pendingHomeworkCount: Number.isSafeInteger(homework.total) ? homework.total : (homework.items || []).length,
      noticeItems: decorateNotices(notices.items),
      importantNoticeCount: Math.min(99, Number.isSafeInteger(notices.total) ? notices.total : (notices.items || []).length),
      schedule: createScheduleOverview(timetable.entries),
      plan: createPlanOverview(plans.items),
      habits: createHabitOverview(habits.items),
      loading: false,
      partialFailure: requests.some((result) => result.failed),
      guestMode: false,
      canManageHomework: canPerform(session.user.role, "createHomework"),
      canImportHomework: canPerform(session.user.role, "importHomework"),
      canManageNotice: canPerform(session.user.role, "manageNotice"),
      canImportNotice: canPerform(session.user.role, "importNotice"),
      canManagePlan: canPerform(session.user.role, "managePlan"),
    });
  },

  onPullDownRefresh() {
    this.onShow().finally(() => wx.stopPullDownRefresh());
  },

  goHomework() { wx.switchTab({ url: "/pages/homework-list/homework-list" }); },
  goNotices() { wx.switchTab({ url: "/pages/notice-list/notice-list" }); },
  goHabits() { getApp().globalData.growthEntry = { view: "habit" }; wx.switchTab({ url: "/pages/habit-list/habit-list" }); },
  goMe() { wx.switchTab({ url: "/pages/settings/settings" }); },
  goTimetable() { wx.navigateTo({ url: "/pages/timetable/timetable" }); },
  goPlans() { getApp().globalData.growthEntry = { view: "plan", date: createHomeDateContext().date }; wx.switchTab({ url: "/pages/habit-list/habit-list" }); },

  openHomework(event) {
    if (this.data.guestMode) {
      const item = this.data.homeworkItems.find((candidate) => candidate._id === event.currentTarget.dataset.id);
      if (!item) return;
      wx.showModal({ title: `${item.subject} · 演示作业`, content: `${item.title}\n\n详细要求：${item.content || "无"}`, showCancel: false, confirmText: "知道了" });
      return;
    }
    wx.navigateTo({ url: `/pages/homework-detail/homework-detail?id=${event.currentTarget.dataset.id}` });
  },

  openNotice(event) {
    if (this.data.guestMode) {
      const item = this.data.noticeItems.find((candidate) => candidate._id === event.currentTarget.dataset.id);
      if (!item) return;
      wx.showModal({ title: item.title, content: item.content || "这是一条本地演示通知。", showCancel: false, confirmText: "知道了" });
      return;
    }
    wx.navigateTo({ url: `/pages/notice-detail/notice-detail?id=${event.currentTarget.dataset.id}` });
  },

  openHabit(event) {
    if (this.data.guestMode) {
      requestFamilyAccess("登录后可记录习惯打卡并与家庭成员同步进度。", wx);
      return;
    }
    wx.navigateTo({ url: `/pages/habit-detail/habit-detail?id=${event.currentTarget.dataset.id}` });
  },

  toggleHomework(event) { return completion.toggle.call(this, event); },
  undoHomework() { return completion.undo.call(this); },
  dismissCompletion() { completion.dismiss.call(this); },
  onHide() { this.dismissCompletion(); },

  importHomework() {
    if (this.data.guestMode) { requestFamilyAccess("登录后可使用 AI 识别图片并生成作业草稿。", wx); return; }
    if (!this.data.canImportHomework) { wx.showToast({ title: "当前账号不能使用 AI 导入", icon: "none" }); return; }
    wx.navigateTo({ url: `/pages/homework-import/homework-import?semester=${encodeURIComponent(this.data.semester)}` });
  },

  importNotice() {
    if (this.data.guestMode) { requestFamilyAccess("登录后可使用 AI 识别截图并生成通知草稿。", wx); return; }
    if (!this.data.canImportNotice) { wx.showToast({ title: "当前账号不能使用 AI 导入", icon: "none" }); return; }
    wx.navigateTo({ url: "/pages/notice-import/notice-import" });
  },

  createPlan() {
    if (this.data.guestMode) { requestFamilyAccess("登录后可创建计划并同步家庭执行进度。", wx); return; }
    if (!this.data.canManagePlan) { wx.showToast({ title: "当前账号不能新增计划", icon: "none" }); return; }
    wx.navigateTo({ url: `/pages/plan-edit/plan-edit?type=daily&date=${createHomeDateContext().date}` });
  },
});
