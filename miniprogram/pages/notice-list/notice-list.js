const { callFunction, showError } = require("../../utils/api");
const { requireFamily } = require("../../utils/session");
const { NOTICE_CATEGORIES } = require("../../utils/constants");
const { formatDateTime } = require("../../utils/date");
const { canPerform } = require("../../utils/permissions");
const { createShareAppMessage, createShareTimelineMessage } = require("../../utils/share");
const { GUEST_SEMESTER_LABEL, createGuestNoticeItems, requestFamilyAccess } = require("../../utils/guest-experience");

const categories = [{ value: "all", label: "全部" }, ...NOTICE_CATEGORIES];

Page({
  onShareAppMessage: createShareAppMessage,
  onShareTimeline: createShareTimelineMessage,

  data: { categories, category: "all", keyword: "", semester: "2026下", items: [], page: 1, hasMore: false, loading: true, canManage: false, guestMode: false },
  async onShow() {
    let session;
    try {
      session = await requireFamily({ redirect: false });
    } catch (error) {
      console.error("Load notice session failed", { message: error.message });
      this.enterGuestMode();
      showError(error, "身份校验失败，请稍后重试");
      return;
    }
    if (!session) { this.enterGuestMode(); return; }
    this.currentUser = session.user;
    this.setData({ semester: session.family.currentSemester, canManage: canPerform(session.user.role, "manageNotice"), guestMode: false });
    await this.load(true);
  },
  enterGuestMode() {
    this.currentUser = null;
    this.setData({ semester: GUEST_SEMESTER_LABEL, category: "all", keyword: "", canManage: false, guestMode: true });
    this.load(true);
  },
  onPullDownRefresh() { this.load(true).finally(() => wx.stopPullDownRefresh()); },
  onReachBottom() { if (this.data.hasMore && !this.data.loading) this.load(false); },
  async load(reset) {
    if (this.data.guestMode) {
      this.setData({ items: createGuestNoticeItems({ category: this.data.category, keyword: this.data.keyword }), page: 1, hasMore: false, loading: false });
      return;
    }
    const page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true });
    try {
      const data = await callFunction("notice", "list", { semester: this.data.semester, category: this.data.category, keyword: this.data.keyword, page, pageSize: 20 });
      const items = data.items.map((item) => ({ ...item, categoryName: (NOTICE_CATEGORIES.find((category) => category.value === item.category) || {}).label || "其他", createdAtText: formatDateTime(item.createdAt) }));
      this.setData({ items: reset ? items : [...this.data.items, ...items], page, hasMore: data.hasMore });
    } catch (error) { showError(error, "通知加载失败"); }
    finally { this.setData({ loading: false }); }
  },
  selectCategory(event) { this.setData({ category: event.currentTarget.dataset.value }); this.load(true); },
  onSearchInput(event) { clearTimeout(this.searchTimer); this.setData({ keyword: event.detail.value }); this.searchTimer = setTimeout(() => this.load(true), 300); },
  create() {
    if (this.data.guestMode) { requestFamilyAccess("登录后可新增通知并设置家庭提醒。", wx); return; }
    if (!canPerform(this.currentUser && this.currentUser.role, "manageNotice")) { wx.showToast({ title: "孩子账号不能新增或编辑通知", icon: "none" }); return; }
    wx.navigateTo({ url: "/pages/notice-edit/notice-edit" });
  },
  view(event) {
    if (this.data.guestMode) {
      const item = this.data.items.find((candidate) => candidate._id === event.currentTarget.dataset.id);
      if (!item) return;
      wx.showModal({ title: item.title, content: `${item.categoryName} · ${item.source || "演示来源"}\n\n${item.content || "这是一条本地演示通知。"}`, showCancel: false, confirmText: "知道了" });
      return;
    }
    wx.navigateTo({ url: `/pages/notice-detail/notice-detail?id=${event.currentTarget.dataset.id}` });
  },
  onUnload() { clearTimeout(this.searchTimer); },
});
