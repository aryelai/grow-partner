const { callFunction, showError } = require("../../utils/api");
const { requireFamily } = require("../../utils/session");
const { NOTICE_CATEGORIES, RELATIONS } = require("../../utils/constants");
const { formatDateTime } = require("../../utils/date");
const { canPerform } = require("../../utils/permissions");
const { decorateNotice } = require("../../utils/notice");
const { createShareAppMessage, createShareTimelineMessage } = require("../../utils/share");

const NOTICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const VALID_ADVANCES = new Set([120, 1440]);

function getValidReminderTime(value) {
  if (value instanceof Date) {
    const date = new Date(value.getTime());
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value) || value === 0)) return null;
  if (typeof value === "string" && !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getRelationLabel(value) {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(RELATIONS, value) ? RELATIONS[value] : "";
}

function getAdvanceText(value) {
  const advance = Array.isArray(value) ? value.map(Number).find((item) => VALID_ADVANCES.has(item)) : null;
  if (advance === 1440) return "提前1天";
  if (advance === 120) return "提前2小时";
  return "未设置";
}

Page({
  onShareAppMessage: createShareAppMessage,
  onShareTimeline: createShareTimelineMessage,

  data: { id: "", item: null, canEdit: false, completionBusy: false },
  async onLoad(options) {
    const id = options && options.id;
    if (typeof id !== "string" || !NOTICE_ID_PATTERN.test(id)) {
      wx.showToast({ title: "通知标识无效", icon: "none" });
      wx.navigateBack();
      return;
    }
    this.setData({ id });
    let session;
    try { session = await requireFamily(); }
    catch (error) { showError(error, "身份校验失败，请稍后重试"); return; }
    if (!session) return;
    this.currentUser = session.user;
    await this.load();
  },
  async load() {
    try {
      const item = await callFunction("notice", "get", { id: this.data.id });
      const category = NOTICE_CATEGORIES.find((value) => value.value === item.category) || { label: "其他" };
      const remindTargets = Array.isArray(item.remindTargets) ? item.remindTargets : [];
      const remindTime = getValidReminderTime(item.remindTime);
      this.setData({
        item: {
          ...decorateNotice(item),
          images: Array.isArray(item.images) ? item.images.filter((value) => typeof value === "string") : [],
          categoryName: category.label,
          hasReminder: Boolean(remindTime),
          remindTimeText: remindTime ? formatDateTime(remindTime) : "",
          advanceText: getAdvanceText(item.remindAdvance),
          targetText: remindTargets.map(getRelationLabel).filter(Boolean).join("、"),
        },
        canEdit: canPerform(this.currentUser.role, "manageNotice"),
      });
    } catch (error) { showError(error, "通知加载失败"); }
  },
  previewImage(event) {
    const url = event.currentTarget.dataset.url;
    if (this.data.item && this.data.item.images.includes(url)) wx.previewImage({ current: url, urls: this.data.item.images });
  },
  onShow() { if (this.currentUser && this.data.id) return this.load(); },
  async toggleCompleted() {
    if (this.data.completionBusy || !this.data.item || !canPerform(this.currentUser && this.currentUser.role, "manageNotice")) return;
    this.setData({ completionBusy: true });
    try {
      await callFunction("notice", "toggleCompleted", { id: this.data.id, isCompleted: !this.data.item.isCompleted });
      await this.load();
    } catch (error) { showError(error, "通知状态更新失败"); }
    finally { this.setData({ completionBusy: false }); }
  },
  async edit() {
    let session;
    try { session = await requireFamily(); }
    catch (error) { showError(error, "身份校验失败，请稍后重试"); return; }
    if (!session) return;
    if (!canPerform(session.user.role, "manageNotice")) { wx.showToast({ title: "孩子账号不能新增或编辑通知", icon: "none" }); return; }
    wx.navigateTo({ url: `/pages/notice-edit/notice-edit?id=${this.data.id}` });
  },
});
