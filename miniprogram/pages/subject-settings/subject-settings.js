const { callFunction, showError } = require("../../utils/api");
const { requireFamily } = require("../../utils/session");
const { createShareAppMessage, createShareTimelineMessage } = require("../../utils/share");

Page({
  onShareAppMessage: createShareAppMessage,
  onShareTimeline: createShareTimelineMessage,

  data: { subjects: [], defaultSubjects: [], subjectItems: [], input: "" },
  async onLoad() { const session = await requireFamily(); if (!session) return; await this.load(); },
  applySubjects(data) { const defaults = new Set(data.defaultSubjects); this.setData({ ...data, subjectItems: data.subjects.map((name) => ({ name, isDefault: defaults.has(name) })) }); },
  async load() { try { const data = await callFunction("settings", "getSubjects"); this.applySubjects(data); } catch (error) { showError(error, "科目加载失败"); } },
  onInput(event) { this.setData({ input: event.detail.value }); },
  async add() { const subject = this.data.input.trim(); if (!subject) return; try { const data = await callFunction("settings", "addSubject", { subject }); this.applySubjects(data); this.setData({ input: "" }); } catch (error) { showError(error); } },
  remove(event) { const subject = event.currentTarget.dataset.subject; wx.showModal({ title: "删除自定义科目", content: `确认删除“${subject}”吗？历史作业中的科目不会变化。`, success: async (result) => { if (!result.confirm) return; try { const data = await callFunction("settings", "removeSubject", { subject }); this.applySubjects(data); } catch (error) { showError(error); } } }); },
});
