const { callFunction, showError } = require("../../utils/api");
const { requireFamily } = require("../../utils/session");
const { DEFAULT_SUBJECTS } = require("../../utils/constants");
const { getBeijingDate, shiftIsoDate, formatDateTime, formatHomeworkDate } = require("../../utils/date");
const { LEARNING_STATE_OPTIONS, decorateLearningState, sortHomework } = require("../../utils/homework");
const { validateIsoDate } = require("../../utils/validation");
const { canPerform } = require("../../utils/permissions");
const { createListCompletion } = require("../../utils/list-completion");
const { createShareAppMessage, createShareTimelineMessage } = require("../../utils/share");
const { GUEST_SEMESTER_LABEL, createGuestHomeworkItems, requestFamilyAccess } = require("../../utils/guest-experience");

const RELATION_NAMES = {
  father: "爸爸", mother: "妈妈", grandpa_paternal: "爷爷", grandma_paternal: "奶奶",
  grandpa_maternal: "外公", grandma_maternal: "外婆", uncle_paternal: "叔叔",
  aunt_paternal: "婶婶", uncle_maternal: "舅舅", aunt_maternal: "舅妈",
  brother: "哥哥", sister: "姐姐", child: "孩子",
};
const completion = createListCompletion({ kind: "homework", permission: "toggleHomework", callFunction, showError,
  reload() { return this.load(true); } });
const initialDate = getBeijingDate();

Page({
  onShareAppMessage: createShareAppMessage,
  onShareTimeline: createShareTimelineMessage,

  data: {
    semester: "2026下",
    scope: "date",
    scopes: [{ value: "date", label: "指定日期" }, { value: "pending", label: "全部待办" }],
    selectedDate: initialDate,
    selectedDateText: formatHomeworkDate(initialDate),
    calendarVisible: false,
    subjects: ["全部"],
    selectedSubject: "全部",
    statuses: [{ value: "all", label: "全部" }, { value: "pending", label: "未完成" }, { value: "completed", label: "已完成" }],
    status: "pending",
    keyword: "",
    items: [],
    page: 1,
    hasMore: false,
    loading: true,
    canManage: false,
    canUseImport: false,
    canImport: false,
    importBlockedReason: "",
    guestMode: false,
    completionBusy: false,
    undoId: "",
    completionText: "",
    learningStateBusy: false,
    loadFailed: false,
  },

  async onShow() {
    const entry = getApp().globalData.homeworkEntry;
    if (entry && validateIsoDate(entry.date)) {
      this.setData({ scope: "date", selectedDate: entry.date, selectedDateText: formatHomeworkDate(entry.date), selectedSubject: "全部", status: "pending", keyword: "" });
    } else if (entry && entry.scope === "pending") {
      this.setData({ scope: "pending", selectedSubject: "全部", status: "pending", keyword: "" });
    }
    getApp().globalData.homeworkEntry = null;
    let session;
    try {
      session = await requireFamily({ redirect: false });
    } catch (error) {
      console.error("Load homework session failed", { message: error.message });
      this.enterGuestMode();
      showError(error, "身份校验失败，请稍后重试");
      return;
    }
    if (!session) { this.enterGuestMode(); return; }
    this.currentUser = session.user;
    const family = session.family;
    let subjectList = DEFAULT_SUBJECTS[family.educationStage] || DEFAULT_SUBJECTS.junior_high;
    try {
      const subjectData = await callFunction("settings", "getSubjects");
      subjectList = subjectData.subjects;
    } catch (error) {
      console.error("Load custom subjects failed", { message: error.message });
    }
    const canManage = canPerform(session.user.role, "createHomework");
    const canUseImport = canPerform(session.user.role, "importHomework");
    this.setData({
      semester: family.currentSemester,
      subjects: ["全部", ...subjectList],
      canManage,
      canUseImport,
      canImport: false,
      importBlockedReason: canUseImport ? "正在检查智能导入服务" : "",
      guestMode: false,
    });
    const homeworkLoad = this.load(true);
    let canImport = false;
    let importBlockedReason = "作业智能导入暂不可用";
    if (canUseImport) {
      try {
        const aiStatus = await callFunction("ai", "getStatus");
        canImport = aiStatus.enabled === true && aiStatus.canImport === true;
        importBlockedReason = canImport ? "" : aiStatus.blockedReason || importBlockedReason;
      } catch (error) {
        importBlockedReason = "作业智能导入状态加载失败，请稍后重试";
        console.error("Load homework image import status failed", { message: error.message });
      }
    }
    this.setData({ canImport, importBlockedReason });
    await homeworkLoad;
  },

  enterGuestMode() {
    this.currentUser = null;
    this.setData({
      semester: GUEST_SEMESTER_LABEL,
      subjects: ["全部", "语文", "数学", "英语"],
      selectedSubject: "全部",
      status: "pending",
      keyword: "",
      canManage: false,
      canUseImport: false,
      canImport: false,
      importBlockedReason: "",
      guestMode: true,
    });
    this.load(true);
  },

  onPullDownRefresh() {
    this.load(true).finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.load(false);
  },

  async load(reset) {
    if (this.data.loading && !reset) return;
    const version = this.loadVersion = (this.loadVersion || 0) + 1;
    if (this.data.guestMode) {
      const items = createGuestHomeworkItems({
        subject: this.data.selectedSubject,
        status: this.data.status,
        keyword: this.data.keyword,
        ...(this.data.scope === "date" ? { homeworkDate: this.data.selectedDate } : {}),
      });
      this.setData({
        items: sortHomework(items.map(decorateLearningState), new Date(), this.data.subjects, { groupBySubject: this.data.scope === "date" }),
        page: 1,
        hasMore: false,
        loading: false,
        loadFailed: false,
      });
      return;
    }
    const page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true, loadFailed: false, ...(reset ? { items: [], hasMore: false } : {}) });
    try {
      const result = await callFunction("homework", "list", {
        ...(this.data.scope === "date" ? { homeworkDate: this.data.selectedDate } : { semester: this.data.semester }),
        subject: this.data.selectedSubject,
        status: this.data.scope === "pending" ? "pending" : this.data.status,
        keyword: this.data.keyword,
        page,
        pageSize: 50,
      });
      if (version !== this.loadVersion) return;
      const now = new Date();
      const items = result.items.map((item) => decorateLearningState({
        ...item,
        images: item.images || [], videos: item.videos || [], links: item.links || [], extraTags: item.extraTags || [],
        createdByName: RELATION_NAMES[item.createdByName] || item.createdByName || "家庭成员",
        deadlineText: item.deadline ? formatDateTime(item.deadline) : "",
        homeworkDateText: formatHomeworkDate(item.homeworkDate),
        homeworkDateMissing: formatHomeworkDate(item.homeworkDate) === "日期待补充",
        isOverdue: item.hasDeadline && !item.isCompleted && new Date(item.deadline).getTime() < now.getTime(),
      }));
      const merged = reset ? items : [...this.data.items, ...items];
      this.setData({
        items: sortHomework(merged, now, this.data.subjects, { groupBySubject: this.data.scope === "date" }),
        page,
        hasMore: result.hasMore,
      });
    } catch (error) {
      if (version !== this.loadVersion) return;
      this.setData({ loadFailed: true });
      showError(error, "作业加载失败");
    } finally {
      if (version === this.loadVersion) this.setData({ loading: false });
    }
  },

  changeDate(event) {
    const selectedDate = shiftIsoDate(this.data.selectedDate, Number(event.currentTarget.dataset.offset));
    this.setData({ selectedDate, selectedDateText: formatHomeworkDate(selectedDate) });
    return this.load(true);
  },
  onDateChange(event) {
    const selectedDate = event.detail.value;
    if (!validateIsoDate(selectedDate)) return;
    this.setData({ selectedDate, selectedDateText: formatHomeworkDate(selectedDate), calendarVisible: false });
    return this.load(true);
  },
  openCalendar() { this.setData({ calendarVisible: true }); },
  closeCalendar() { this.setData({ calendarVisible: false }); },
  selectScope(event) {
    const scope = event.currentTarget.dataset.value;
    if (!["date", "pending"].includes(scope) || scope === this.data.scope) return Promise.resolve();
    this.setData({ scope, status: scope === "pending" ? "pending" : this.data.status });
    return this.load(true);
  },
  selectSubject(event) { this.setData({ selectedSubject: event.currentTarget.dataset.value }); this.load(true); },
  selectStatus(event) { this.setData({ status: event.currentTarget.dataset.value }); this.load(true); },
  onSearchInput(event) {
    clearTimeout(this.searchTimer);
    this.setData({ keyword: event.detail.value });
    this.searchTimer = setTimeout(() => this.load(true), 300);
  },
  createHomework() {
    if (this.data.guestMode) { requestFamilyAccess("登录后可保存并与家庭成员共享作业。", wx); return; }
    if (!canPerform(this.currentUser && this.currentUser.role, "createHomework")) { wx.showToast({ title: "孩子账号不能新增作业", icon: "none" }); return; }
    wx.navigateTo({ url: `/pages/homework-edit/homework-edit?semester=${this.data.semester}&homeworkDate=${this.data.selectedDate}` });
  },
  importHomework() {
    if (this.data.guestMode) { requestFamilyAccess("登录后可识别作业图片并整理为可编辑草稿。", wx); return; }
    if (!canPerform(this.currentUser && this.currentUser.role, "importHomework")) {
      wx.showToast({ title: "孩子账号不能使用智能导入", icon: "none" });
      return;
    }
    if (!this.data.canImport) {
      wx.showModal({
        title: "智能导入暂不可用",
        content: this.data.importBlockedReason || "请稍后重试",
        showCancel: false,
      });
      return;
    }
    wx.navigateTo({ url: `/pages/homework-import/homework-import?semester=${encodeURIComponent(this.data.semester)}` });
  },
  openDetail(event) {
    if (this.data.guestMode) {
      const item = this.data.items.find((candidate) => candidate._id === event.currentTarget.dataset.id);
      if (!item) return;
      wx.showModal({ title: "演示作业详情", content: `${item.subject} · 作业日期：${item.homeworkDateText}\n\n${item.title}\n\n详细要求：${item.content || "无"}`, showCancel: false, confirmText: "知道了" });
      return;
    }
    wx.navigateTo({ url: `/pages/homework-detail/homework-detail?id=${event.currentTarget.dataset.id}` });
  },
  previewImage(event) { wx.previewImage({ current: event.currentTarget.dataset.url, urls: event.currentTarget.dataset.urls }); },
  toggleCompleted(event) { return completion.toggle.call(this, event); },
  changeLearningState(event) {
    if (this.data.guestMode) {
      requestFamilyAccess("登录后可标记作业的学习处理状态。", wx);
      return;
    }
    if (this.data.learningStateBusy || !canPerform(this.currentUser && this.currentUser.role, "updateHomeworkLearningState")) return;
    const id = event.currentTarget.dataset.id;
    wx.showActionSheet({
      itemList: LEARNING_STATE_OPTIONS.map((item) => item.label),
      success: async ({ tapIndex }) => {
        const option = LEARNING_STATE_OPTIONS[tapIndex];
        if (!option) return;
        this.setData({ learningStateBusy: true });
        try {
          await callFunction("homework", "updateLearningState", { id, learningState: option.value });
          await this.load(true);
        } catch (error) {
          showError(error, "学习状态更新失败");
        } finally {
          this.setData({ learningStateBusy: false });
        }
      },
    });
  },
  undoCompleted() { return completion.undo.call(this); },
  dismissCompletion() { completion.dismiss.call(this); },
  retryLoad() { return this.load(true); },
  showMore() { wx.showActionSheet({ itemList: ["查看课程表"], success: () => wx.navigateTo({ url: "/pages/timetable/timetable" }) }); },
  onHide() { clearTimeout(this.searchTimer); this.dismissCompletion(); },
  onUnload() { clearTimeout(this.searchTimer); this.loadVersion = (this.loadVersion || 0) + 1; },
});
