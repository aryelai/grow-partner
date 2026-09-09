const { callFunction, showError, uploadFile } = require("../../utils/api");
const { requireFamily } = require("../../utils/session");
const { NOTICE_CATEGORIES } = require("../../utils/constants");
const { formatDate } = require("../../utils/date");
const { canPerform } = require("../../utils/permissions");

Page({
  data: {
    id: "", categories: NOTICE_CATEGORIES,
    form: { semester: "2026下", title: "", source: "", category: "other", content: "", images: [], remindAdvance: [1440, 120], remindTargets: ["father", "mother"] },
    reminderEnabled: false, remindDate: formatDate(new Date()), remindTime: "08:00", advanceDay: true, advanceHours: true, uploading: false, submitting: false,
  },
  async refreshPermission() {
    let session;
    try { session = await requireFamily(); }
    catch (error) { this.currentUser = null; this.familyId = null; showError(error, "身份校验失败，请稍后重试"); return null; }
    if (!session) { this.currentUser = null; this.familyId = null; return null; }
    this.currentUser = session.user;
    this.familyId = session.user.familyId;
    if (!canPerform(session.user.role, "manageNotice")) { wx.showToast({ title: "孩子账号不能新增或编辑通知", icon: "none" }); return null; }
    return session;
  },
  async onLoad(options) {
    const session = await this.refreshPermission(); if (!session) { if (this.currentUser) wx.navigateBack(); return; }
    this.setData({ id: options.id || "", "form.semester": session.family.currentSemester });
    if (options.id) await this.load(options.id);
  },
  async load(id) {
    try {
      const item = await callFunction("notice", "get", { id });
      const remind = item.remindTime ? new Date(item.remindTime) : new Date();
      this.setData({ form: { ...item, images: item.images || [], remindAdvance: item.remindAdvance || [], remindTargets: item.remindTargets || [] }, reminderEnabled: Boolean(item.remindTime), remindDate: formatDate(remind), remindTime: `${String(remind.getHours()).padStart(2, "0")}:${String(remind.getMinutes()).padStart(2, "0")}`, advanceDay: (item.remindAdvance || []).includes(1440), advanceHours: (item.remindAdvance || []).includes(120) });
    } catch (error) { showError(error); }
  },
  onInput(event) { this.setData({ [`form.${event.currentTarget.dataset.field}`]: event.detail.value }); },
  selectCategory(event) { this.setData({ "form.category": event.currentTarget.dataset.value }); },
  toggleReminder(event) { this.setData({ reminderEnabled: event.detail.value }); },
  onRemindDate(event) { this.setData({ remindDate: event.detail.value }); },
  onRemindTime(event) { this.setData({ remindTime: event.detail.value }); },
  onAdvanceChange(event) { const values = event.detail.value.map(Number); this.setData({ "form.remindAdvance": values, advanceDay: values.includes(1440), advanceHours: values.includes(120) }); },
  async chooseImages() {
    if (!await this.refreshPermission()) { this.setData({ uploading: false }); return; }
    try {
      const result = await wx.chooseMedia({ count: 9 - this.data.form.images.length, mediaType: ["image"], sizeType: ["compressed"] });
      const session = await this.refreshPermission();
      if (!session) return;
      if (result.tempFiles.some((item) => item.size > 10 * 1024 * 1024)) { wx.showToast({ title: "单张图片不能超过10MB", icon: "none" }); return; }
      this.setData({ uploading: true });
      const stamp = Date.now();
      const images = await Promise.all(result.tempFiles.map((item, index) => uploadFile(`notices/${session.user.familyId}/${stamp}-${index}.jpg`, item.tempFilePath)));
      this.setData({ "form.images": [...this.data.form.images, ...images] });
    } catch (error) { if (!String(error.errMsg || error.message).includes("cancel")) showError(error); }
    finally { this.setData({ uploading: false }); }
  },
  removeImage(event) { const images = [...this.data.form.images]; images.splice(event.currentTarget.dataset.index, 1); this.setData({ "form.images": images }); },
  async save() {
    if (this.saveInProgress) return;
    this.saveInProgress = true;
    this.setData({ submitting: true });
    try {
      if (!await this.refreshPermission()) return;
      if (!this.data.form.title.trim()) { wx.showToast({ title: "请填写通知标题", icon: "none" }); return; }
      const remindTime = this.data.reminderEnabled ? new Date(`${this.data.remindDate}T${this.data.remindTime}:00`).toISOString() : null;
      await callFunction("notice", this.data.id ? "update" : "create", { ...this.data.form, id: this.data.id, remindTime }); wx.navigateBack();
    }
    catch (error) { showError(error, "通知保存失败"); }
    finally { this.saveInProgress = false; this.setData({ submitting: false }); }
  },
  async remove() { if (!await this.refreshPermission()) return; wx.showModal({ title: "删除通知", content: "删除后无法恢复，确认继续吗？", success: async (result) => { if (!result.confirm) return; if (!await this.refreshPermission()) return; try { await callFunction("notice", "remove", { id: this.data.id }); wx.navigateBack(); } catch (error) { showError(error); } } }); },
});
