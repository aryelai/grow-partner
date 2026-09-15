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
  },

  async onLoad() {
    const session = await requireFamily();
    if (!session) return;
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
      subjectItems: subjects.map((name) => ({ name, isDefault: defaults.has(name) })),
    });
  },

  async load() {
    try {
      const data = await callFunction("settings", "getSubjects");
      this.applySubjects(data);
    } catch (error) {
      showError(error, "科目加载失败");
    }
  },

  onInput(event) {
    this.setData({ input: event.detail.value });
  },

  async add() {
    const subject = this.data.input.trim();
    if (!subject) return;
    try {
      const data = await callFunction("settings", "addSubject", { subject });
      this.applySubjects(data);
      this.setData({ input: "" });
    } catch (error) {
      showError(error);
    }
  },

  beginRename(event) {
    const subject = event.currentTarget.dataset.subject;
    if (this.data.renaming || typeof subject !== "string" || !subject) return;
    this.setData({ editingSubject: subject, editingInput: subject });
  },

  onRenameInput(event) {
    this.setData({ editingInput: event.detail.value });
  },

  cancelRename() {
    if (this.data.renaming) return;
    this.setData({ editingSubject: "", editingInput: "" });
  },

  async rename() {
    if (this.data.renaming) return;
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
    wx.showModal({
      title: "删除自定义科目",
      content: `确认删除“${subject}”吗？历史作业中的科目不会变化。`,
      success: async (result) => {
        if (!result.confirm) return;
        try {
          const data = await callFunction("settings", "removeSubject", { subject });
          this.applySubjects(data);
          if (this.data.editingSubject === subject) this.cancelRename();
        } catch (error) {
          showError(error);
        }
      },
    });
  },
});
