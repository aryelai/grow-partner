const { callFunction, showError } = require("../../utils/api");
const { requireFamily } = require("../../utils/session");
const { formatDateTime } = require("../../utils/date");
const { RELATIONS } = require("../../utils/constants");

Page({
  data: { id: "", item: null, canEdit: false },
  onLoad(options) { this.setData({ id: options.id || "" }); },
  async onShow() {
    const session = await requireFamily();
    if (!session || !this.data.id) return;
    this.currentUser = session.user;
    await this.load();
  },
  async load() {
    try {
      const item = await callFunction("homework", "get", { id: this.data.id });
      const isOverdue = item.hasDeadline && !item.isCompleted && new Date(item.deadline).getTime() < Date.now();
      this.setData({
        item: { ...item, images: item.images || [], videos: item.videos || [], links: item.links || [], extraTags: item.extraTags || [], createdByName: RELATIONS[item.createdByName] || item.createdByName, createdAtText: formatDateTime(item.createdAt), deadlineText: formatDateTime(item.deadline), isOverdue },
        canEdit: this.currentUser.role !== "child",
      });
    } catch (error) { showError(error); }
  },
  previewImage(event) { wx.previewImage({ current: event.currentTarget.dataset.url, urls: this.data.item.images }); },
  copyLink(event) { wx.setClipboardData({ data: event.currentTarget.dataset.url }); },
  edit() { wx.navigateTo({ url: `/pages/homework-edit/homework-edit?id=${this.data.id}` }); },
  async toggleCompleted() {
    try { await callFunction("homework", "toggleCompleted", { id: this.data.id, isCompleted: !this.data.item.isCompleted }); await this.load(); }
    catch (error) { showError(error); }
  },
  remove() {
    wx.showModal({ title: "删除作业", content: "删除后无法恢复，确认继续吗？", success: async (result) => {
      if (!result.confirm) return;
      try { await callFunction("homework", "remove", { id: this.data.id }); wx.navigateBack(); }
      catch (error) { showError(error); }
    } });
  },
});
