const { callFunction, showError } = require("../../utils/api");
const { requireFamily } = require("../../utils/session");
const { createShareAppMessage, createShareTimelineMessage } = require("../../utils/share");

Page({
  onShareAppMessage: createShareAppMessage,
  onShareTimeline: createShareTimelineMessage,

  data: {
    subjects: [],
    defaultSubjects: [],
    subjectItems: [],
    input: "",
    editingSubject: "",
    editingInput: "",
    renaming: false,
    loading: true,
    changing: false,
    canManage: false,
    editingCanRemove: false,
  },

  async onLoad() {
    const session = await requireFamily();
    if (!session) return;
    this.setData({ canManage: session.user.role === "creator" || (session.user.role === "member" && session.family && session.family.allowMemberEditSettings === true) });
    await this.load();
  },

  applySubjects(data) {
    const subjects = Array.isArray(data.subjects) ? data.subjects : [];
    const defaultSubjects = Array.isArray(data.defaultSubjects) ? data.defaultSubjects : [];
    const customSubjects = Array.isArray(data.customSubjects) ? data.customSubjects : [];
    const defaults = new Set(defaultSubjects);
    this.setData({
      subjects,
      defaultSubjects,
      customSubjects,
      ...(typeof data.canManageSubjects === "boolean" ? { canManage: data.canManageSubjects } : {}),
      subjectItems: subjects.map((name) => ({ name, isDefault: defaults.has(name) })),
    });
  },

  async load() {
    this.setData({ loading: true });
    try {
      const data = await callFunction("settings", "getSubjects");
      this.applySubjects(data);
    } catch (error) {
      showError(error, "科目加载失败");
    } finally {
      this.setData({ loading: false });
    }
  },

  onInput(event) {
    this.setData({ input: event.detail.value });
  },

  async add() {
    if (!this.data.canManage || this.data.changing || this.data.renaming || this.data.loading) return;
    const subject = this.data.input.trim();
    if (!subject) return;
    this.setData({ changing: true });
    try {
      const data = await callFunction("settings", "addSubject", { subject });
      this.applySubjects(data);
      this.setData({ input: "" });
    } catch (error) {
      showError(error);
    } finally {
      this.setData({ changing: false });
    }
  },

  beginRename(event) {
    const subject = event.currentTarget.dataset.subject;
    if (!this.data.canManage || this.data.renaming || this.data.changing || !this.data.subjects.includes(subject)) return;
    this.setData({ editingSubject: subject, editingInput: subject, editingCanRemove: !this.data.defaultSubjects.includes(subject) }, () => {
      if (typeof wx.pageScrollTo === "function") wx.pageScrollTo({ selector: ".edit-card", duration: 200 });
    });
  },

  onRenameInput(event) {
    this.setData({ editingInput: event.detail.value });
  },

  cancelRename() {
    if (this.data.renaming || this.data.changing) return;
    this.setData({ editingSubject: "", editingInput: "", editingCanRemove: false });
  },

  async rename() {
    if (!this.data.canManage || this.data.renaming || this.data.changing) return;
    const subject = this.data.editingSubject;
    const newSubject = this.data.editingInput.trim();
    if (!subject || !newSubject) {
      wx.showToast({ title: "科目名称不能为空", icon: "none" });
      return;
    }
    if (newSubject === subject) {
      this.cancelRename();
      return;
    }
    this.setData({ renaming: true });
    try {
      const data = await callFunction("settings", "renameSubject", { subject, newSubject });
      this.applySubjects(data);
      this.setData({ editingSubject: "", editingInput: "" });
      wx.showToast({ title: "科目名称已修改", icon: "success" });
    } catch (error) {
      showError(error, "科目修改失败");
    } finally {
      this.setData({ renaming: false });
    }
  },

  remove(event) {
    const subject = event.currentTarget.dataset.subject;
    if (!this.data.canManage || this.data.changing || this.data.renaming || subject !== this.data.editingSubject || !this.data.editingCanRemove) return;
    this.setData({ changing: true });
    wx.showModal({
      title: "删除自定义科目",
      content: `确认删除“${subject}”吗？历史作业中的科目不会变化。`,
      success: async (result) => {
        if (!result.confirm) { this.setData({ changing: false }); return; }
        try {
          const data = await callFunction("settings", "removeSubject", { subject });
          this.applySubjects(data);
          this.setData({ editingSubject: "", editingInput: "", editingCanRemove: false });
        } catch (error) {
          showError(error);
        } finally {
          this.setData({ changing: false });
        }
      },
      fail: (error) => { this.setData({ changing: false }); showError(error, "删除确认未能打开"); },
    });
  },

  async moveSubject(event) {
    if (!this.data.canManage || this.data.changing || this.data.renaming || this.data.loading) return;
    const subject = event.currentTarget.dataset.subject;
    const offset = Number(event.currentTarget.dataset.offset);
    const index = this.data.subjects.indexOf(subject);
    if (![-1, 1].includes(offset) || index < 0 || index + offset < 0 || index + offset >= this.data.subjects.length) return;
    this.setData({ changing: true });
    try {
      this.applySubjects(await callFunction("settings", "moveSubject", { subject, offset }));
    } catch (error) {
      showError(error, "科目排序失败，顺序未改变");
    } finally {
      this.setData({ changing: false });
    }
  },
});
