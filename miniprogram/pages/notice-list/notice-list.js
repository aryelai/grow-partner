const { callFunction, showError } = require("../../utils/api");
const { requireFamily } = require("../../utils/session");
const { NOTICE_CATEGORIES } = require("../../utils/constants");
const { decorateNotice } = require("../../utils/notice");
const { createListCompletion } = require("../../utils/list-completion");
const { canPerform } = require("../../utils/permissions");
const { createShareAppMessage, createShareTimelineMessage } = require("../../utils/share");
const { GUEST_SEMESTER_LABEL, createGuestNoticeItems, requestFamilyAccess } = require("../../utils/guest-experience");

const categories = [{ value: "all", label: "全部分类" }, ...NOTICE_CATEGORIES];
const statuses = [{ value: "all", label: "全部" }, { value: "pending", label: "待处理" }, { value: "completed", label: "已完成" }];
const completion = createListCompletion({ kind: "notice", permission: "manageNotice", callFunction, showError,
  reload() { return this.load(true); } });

Page({
  onShareAppMessage: createShareAppMessage,
  onShareTimeline: createShareTimelineMessage,

  data: { categories, category: "all", statuses, status: "all", keyword: "", semester: "2026下", items: [], total: 0, page: 1, hasMore: false, loading: true, canManage: false, canUseImport: false, canImport: false, importBlockedReason: "", guestMode: false, completionBusy: false, undoId: "", completionText: "", loadFailed: false },
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
    const canUseImport = canPerform(session.user.role, "importNotice");
    this.setData({ semester: session.family.currentSemester, canManage: canPerform(session.user.role, "manageNotice"), canUseImport, canImport: false, importBlockedReason: canUseImport ? "正在检查 AI 导入状态" : "", guestMode: false });
    const noticeLoad = this.load(true);
    let canImport = false;
    let importBlockedReason = "AI 通知导入暂不可用";
    if (canUseImport) {
      try {
        const aiStatus = await callFunction("ai", "getStatus");
        canImport = aiStatus.enabled === true && aiStatus.canImport === true;
        importBlockedReason = canImport ? "" : aiStatus.blockedReason || importBlockedReason;
      } catch (error) {
        importBlockedReason = "AI 通知导入状态加载失败，请稍后重试";
        console.error("Load notice AI import status failed", { message: error.message });
      }
    }
    this.setData({ canImport, importBlockedReason });
    await noticeLoad;
  },
  enterGuestMode() {
    this.currentUser = null;
    this.setData({ semester: GUEST_SEMESTER_LABEL, category: "all", keyword: "", canManage: false, canUseImport: false, canImport: false, importBlockedReason: "", guestMode: true });
    this.load(true);
  },
  onPullDownRefresh() { this.load(true).finally(() => wx.stopPullDownRefresh()); },
  onReachBottom() { if (this.data.hasMore && !this.data.loading) this.load(false); },
  async load(reset) {
    if (this.data.loading && !reset) return;
    const version = this.loadVersion = (this.loadVersion || 0) + 1;
    if (this.data.guestMode) {
      const items = createGuestNoticeItems({ category: this.data.category, status: this.data.status, keyword: this.data.keyword }).map(decorateNotice);
      this.setData({ items, total: items.length, page: 1, hasMore: false, loading: false, loadFailed: false });
      return;
    }
    const page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true, loadFailed: false, ...(reset ? { items: [], total: 0, hasMore: false } : {}) });
    try {
      const data = await callFunction("notice", "list", { semester: this.data.semester, category: this.data.category, status: this.data.status, keyword: this.data.keyword, page, pageSize: 20 });
      if (version !== this.loadVersion) return;
      const items = data.items.map(decorateNotice);
      this.setData({ items: reset ? items : [...this.data.items, ...items], total: data.total, page, hasMore: data.hasMore });
    } catch (error) {
      if (version !== this.loadVersion) return;
      this.setData({ loadFailed: true });
      showError(error, "通知加载失败");
    } finally { if (version === this.loadVersion) this.setData({ loading: false }); }
  },
  selectStatus(event) { this.setData({ status: event.currentTarget.dataset.value }); this.load(true); },
  selectCategory(event) { this.setData({ category: event.currentTarget.dataset.value }); this.load(true); },
  onSearchInput(event) { clearTimeout(this.searchTimer); this.setData({ keyword: event.detail.value }); this.searchTimer = setTimeout(() => this.load(true), 300); },
  create() {
    if (this.data.guestMode) { requestFamilyAccess("登录后可新增通知并设置家庭提醒。", wx); return; }
    if (!canPerform(this.currentUser && this.currentUser.role, "manageNotice")) { wx.showToast({ title: "孩子账号不能新增或编辑通知", icon: "none" }); return; }
    wx.navigateTo({ url: "/pages/notice-edit/notice-edit" });
  },
  importNotice() {
    if (this.data.guestMode) { requestFamilyAccess("登录后可使用 AI 识别截图并生成通知草稿。", wx); return; }
    if (!canPerform(this.currentUser && this.currentUser.role, "importNotice")) {
      wx.showToast({ title: "孩子账号不能使用 AI 导入", icon: "none" });
      return;
    }
    if (!this.data.canImport) {
      wx.showModal({ title: "AI 导入暂不可用", content: this.data.importBlockedReason || "请稍后重试", showCancel: false });
      return;
    }
    wx.navigateTo({ url: "/pages/notice-import/notice-import" });
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
  toggleCompleted(event) { return completion.toggle.call(this, event); },
  undoCompleted() { return completion.undo.call(this); },
  dismissCompletion() { completion.dismiss.call(this); },
  retryLoad() { return this.load(true); },
  showMore() { wx.showActionSheet({ itemList: ["提醒设置"], success: () => wx.switchTab({ url: "/pages/settings/settings" }) }); },
  onHide() { clearTimeout(this.searchTimer); this.dismissCompletion(); },
  onUnload() { clearTimeout(this.searchTimer); this.loadVersion = (this.loadVersion || 0) + 1; },
});
