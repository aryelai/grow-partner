const { callFunction, showError } = require("../../utils/api");
const { requireFamily } = require("../../utils/session");
const { formatDateTime } = require("../../utils/date");
const { RELATIONS } = require("../../utils/constants");
const { canPerform } = require("../../utils/permissions");
const { createShareAppMessage, createShareTimelineMessage } = require("../../utils/share");

Page({
  onShareAppMessage: createShareAppMessage,
  onShareTimeline: createShareTimelineMessage,

  data: { id: "", item: null, canEdit: false },
  onLoad(options) { this.setData({ id: options.id || "" }); },
  async refreshCurrentUser() {
    let session;
    try { session = await requireFamily(); }
    catch (error) { this.currentUser = null; this.setData({ canEdit: false }); showError(error, "身份校验失败，请稍后重试"); return null; }
    if (!session) { this.currentUser = null; this.setData({ canEdit: false }); return null; }
    this.currentUser = session.user;
    return session;
  },
  async onShow() {
    const session = await this.refreshCurrentUser();
    if (!session) return;
    if (!this.data.id) return;
    await this.load();
  },
  async load() {
    try {
      const item = await callFunction("homework", "get", { id: this.data.id });
      const isOverdue = item.hasDeadline && !item.isCompleted && new Date(item.deadline).getTime() < Date.now();
      this.setData({
        item: { ...item, images: item.images || [], videos: item.videos || [], links: item.links || [], extraTags: item.extraTags || [], createdByName: RELATIONS[item.createdByName] || item.createdByName, createdAtText: formatDateTime(item.createdAt), deadlineText: formatDateTime(item.deadline), isOverdue },
        canEdit: canPerform(this.currentUser.role, "updateHomework"),
      });
    } catch (error) { showError(error); }
  },
  previewImage(event) { wx.previewImage({ current: event.currentTarget.dataset.url, urls: this.data.item.images }); },
  copyLink(event) { wx.setClipboardData({ data: event.currentTarget.dataset.url }); },
  async edit() {
    const session = await this.refreshCurrentUser();
    if (!session) return;
    if (!canPerform(session.user.role, "updateHomework")) { wx.showToast({ title: "孩子账号不能新增或编辑作业", icon: "none" }); return; }
    wx.navigateTo({ url: `/pages/homework-edit/homework-edit?id=${this.data.id}` });
  },
  async toggleCompleted() {
    try { await callFunction("homework", "toggleCompleted", { id: this.data.id, isCompleted: !this.data.item.isCompleted }); await this.load(); }
    catch (error) { showError(error); }
  },
  async remove() {
    const session = await this.refreshCurrentUser();
    if (!session) return;
    if (!canPerform(session.user.role, "requestDeleteHomework")) { wx.showToast({ title: "孩子账号不能删除作业", icon: "none" }); return; }
    wx.showModal({ title: "删除作业", content: "删除后无法恢复，确认继续吗？", success: async (result) => {
      if (!result.confirm) return;
      const latestSession = await this.refreshCurrentUser();
      if (!latestSession) return;
      if (!canPerform(latestSession.user.role, "requestDeleteHomework")) { wx.showToast({ title: "孩子账号不能删除作业", icon: "none" }); return; }
      try { await callFunction("homework", "remove", { id: this.data.id }); wx.navigateBack(); }
      catch (error) { showError(error); }
    } });
  },
});
