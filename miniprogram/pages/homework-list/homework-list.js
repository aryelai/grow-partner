const { callFunction, showError } = require("../../utils/api");
const { requireFamily } = require("../../utils/session");
const { DEFAULT_SUBJECTS } = require("../../utils/constants");
const { getAdjacentSemester, formatDateTime } = require("../../utils/date");
const { sortHomework } = require("../../utils/homework");
const { canPerform } = require("../../utils/permissions");

const RELATION_NAMES = {
  father: "爸爸", mother: "妈妈", grandpa_paternal: "爷爷", grandma_paternal: "奶奶",
  grandpa_maternal: "外公", grandma_maternal: "外婆", uncle_paternal: "叔叔",
  aunt_paternal: "婶婶", uncle_maternal: "舅舅", aunt_maternal: "舅妈",
  brother: "哥哥", sister: "姐姐", child: "孩子",
};

Page({
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
  },

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
    const family = session.family;
    let subjectList = DEFAULT_SUBJECTS[family.educationStage] || DEFAULT_SUBJECTS.junior_high;
    try {
      const subjectData = await callFunction("settings", "getSubjects");
      subjectList = subjectData.subjects;
    } catch (error) {
      console.error("Load custom subjects failed", { message: error.message });
    }
    this.setData({
      semester: family.currentSemester,
      subjects: ["全部", ...subjectList],
      canManage: canPerform(session.user.role, "createHomework"),
    });
    await this.load(true);
  },

  onPullDownRefresh() {
    this.load(true).finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.load(false);
  },

  async load(reset) {
    if (this.data.loading && !reset) return;
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
    if (!canPerform(this.currentUser && this.currentUser.role, "createHomework")) { wx.showToast({ title: "孩子账号不能新增作业", icon: "none" }); return; }
    wx.navigateTo({ url: `/pages/homework-edit/homework-edit?semester=${this.data.semester}` });
  },
  openDetail(event) { wx.navigateTo({ url: `/pages/homework-detail/homework-detail?id=${event.currentTarget.dataset.id}` }); },
  previewImage(event) { wx.previewImage({ current: event.currentTarget.dataset.url, urls: event.currentTarget.dataset.urls }); },
  async toggleCompleted(event) {
    try {
      await callFunction("homework", "toggleCompleted", { id: event.currentTarget.dataset.id, isCompleted: !event.currentTarget.dataset.completed });
      await this.load(true);
    } catch (error) { showError(error); }
  },
  onUnload() { clearTimeout(this.searchTimer); },
});
