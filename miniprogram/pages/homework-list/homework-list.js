const { callFunction, showError } = require("../../utils/api");
const { requireFamily } = require("../../utils/session");
const { DEFAULT_SUBJECTS } = require("../../utils/constants");
const { getAdjacentSemester, formatDateTime, formatHomeworkDate } = require("../../utils/date");
const { sortHomework } = require("../../utils/homework");
const { canPerform } = require("../../utils/permissions");
const { createShareAppMessage, createShareTimelineMessage } = require("../../utils/share");
const { GUEST_SEMESTER_LABEL, createGuestHomeworkItems, requestFamilyAccess } = require("../../utils/guest-experience");

const RELATION_NAMES = {
  father: "爸爸", mother: "妈妈", grandpa_paternal: "爷爷", grandma_paternal: "奶奶",
  grandpa_maternal: "外公", grandma_maternal: "外婆", uncle_paternal: "叔叔",
  aunt_paternal: "婶婶", uncle_maternal: "舅舅", aunt_maternal: "舅妈",
  brother: "哥哥", sister: "姐姐", child: "孩子",
};

Page({
  onShareAppMessage: createShareAppMessage,
  onShareTimeline: createShareTimelineMessage,

  data: {
    semester: "2026下",
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
  },

  async onShow() {
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
    this.guestCompletionState = null;
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
      importBlockedReason: canUseImport ? "正在检查 AI 导入状态" : "",
      guestMode: false,
    });
    const homeworkLoad = this.load(true);
    let canImport = false;
    let importBlockedReason = "AI 作业导入暂不可用";
    if (canUseImport) {
      try {
        const aiStatus = await callFunction("ai", "getStatus");
        canImport = aiStatus.enabled === true && aiStatus.canImport === true;
        importBlockedReason = canImport ? "" : aiStatus.blockedReason || importBlockedReason;
      } catch (error) {
        importBlockedReason = "AI 作业导入状态加载失败，请稍后重试";
        console.error("Load AI import status failed", { message: error.message });
      }
    }
    this.setData({ canImport, importBlockedReason });
    await homeworkLoad;
  },

  enterGuestMode() {
    this.currentUser = null;
    if (!this.guestCompletionState) this.guestCompletionState = Object.create(null);
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
    if (this.data.guestMode) {
      const items = createGuestHomeworkItems({
        subject: this.data.selectedSubject,
        status: this.data.status,
        keyword: this.data.keyword,
      }).map((item) => this.guestCompletionState && Object.prototype.hasOwnProperty.call(this.guestCompletionState, item._id)
        ? { ...item, isCompleted: this.guestCompletionState[item._id] }
        : item);
      this.setData({ items, page: 1, hasMore: false, loading: false });
      return;
    }
    const page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true });
    try {
      const result = await callFunction("homework", "list", {
        semester: this.data.semester,
        subject: this.data.selectedSubject,
        status: this.data.status,
        keyword: this.data.keyword,
        page,
        pageSize: 20,
      });
      const now = new Date();
      const items = result.items.map((item) => ({
        ...item,
        images: item.images || [], videos: item.videos || [], links: item.links || [], extraTags: item.extraTags || [],
        createdByName: RELATION_NAMES[item.createdByName] || item.createdByName || "家庭成员",
        deadlineText: item.deadline ? formatDateTime(item.deadline) : "",
        homeworkDateText: formatHomeworkDate(item.homeworkDate),
        homeworkDateMissing: formatHomeworkDate(item.homeworkDate) === "日期待补充",
        isOverdue: item.hasDeadline && !item.isCompleted && new Date(item.deadline).getTime() < now.getTime(),
      }));
      const merged = reset ? items : [...this.data.items, ...items];
      this.setData({ items: sortHomework(merged, now), page, hasMore: result.hasMore });
    } catch (error) {
      showError(error, "作业加载失败");
    } finally {
      this.setData({ loading: false });
    }
  },

  changeSemester(event) {
    if (this.data.guestMode) return;
    this.setData({ semester: getAdjacentSemester(this.data.semester, Number(event.currentTarget.dataset.offset)) });
    this.load(true);
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
    wx.navigateTo({ url: `/pages/homework-edit/homework-edit?semester=${this.data.semester}` });
  },
  importHomework() {
    if (this.data.guestMode) { requestFamilyAccess("登录后可使用 AI 识别图片并生成作业草稿。", wx); return; }
    if (!canPerform(this.currentUser && this.currentUser.role, "importHomework")) {
      wx.showToast({ title: "孩子账号不能使用 AI 导入", icon: "none" });
      return;
    }
    if (!this.data.canImport) {
      wx.showModal({
        title: "AI 导入暂不可用",
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
  async toggleCompleted(event) {
    if (this.data.guestMode) {
      const id = event.currentTarget.dataset.id;
      const isCompleted = !event.currentTarget.dataset.completed;
      this.guestCompletionState[id] = isCompleted;
      this.setData({ items: this.data.items.map((item) => item._id === id ? { ...item, isCompleted } : item) });
      return;
    }
    try {
      await callFunction("homework", "toggleCompleted", { id: event.currentTarget.dataset.id, isCompleted: !event.currentTarget.dataset.completed });
      await this.load(true);
    } catch (error) { showError(error); }
  },
  onUnload() { clearTimeout(this.searchTimer); },
});
