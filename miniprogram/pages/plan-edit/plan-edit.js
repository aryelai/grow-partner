const { callFunction, showError } = require("../../utils/api");
const { requireFamily } = require("../../utils/session");
const { PLAN_TYPES, PRIORITIES } = require("../../utils/constants");
const { formatDate } = require("../../utils/date");
const { canPerform } = require("../../utils/permissions");
const { createShareAppMessage, createShareTimelineMessage } = require("../../utils/share");

const assignees = [{ value: "child", label: "孩子" }, { value: "father", label: "爸爸" }, { value: "mother", label: "妈妈" }, { value: "all", label: "全家" }];

function decorateItems(items) {
  return items.map((item) => ({ ...item, priorityIndex: Math.max(0, PRIORITIES.findIndex((priority) => priority.value === item.priority)) }));
}

Page({
  onShareAppMessage: createShareAppMessage,
  onShareTimeline: createShareTimelineMessage,

  data: { id: "", types: PLAN_TYPES, priorityLabels: PRIORITIES.map((item) => item.label), assigneeLabels: assignees.map((item) => item.label), assigneeIndex: 0, childMode: false, canEditCurrent: true, form: { type: "daily", date: formatDate(new Date()), semester: "2026下", title: "", items: decorateItems([{ text: "", isDone: false, priority: "medium" }]), assignee: "child", notes: "", linkedHomeworkIds: [], linkedHabitIds: [] }, submitting: false },
  async refreshPermission() { let session; try { session = await requireFamily(); } catch (error) { this.currentUser = null; showError(error, "身份校验失败，请稍后重试"); return null; } if (!session) { this.currentUser = null; return null; } this.currentUser = session.user; if (!canPerform(session.user.role, "createOwnPlan")) { wx.showToast({ title: "当前账号不能维护计划", icon: "none" }); return null; } return session; },
  async onLoad(options) { const session = await this.refreshPermission(); if (!session) { if (this.currentUser) wx.navigateBack(); return; } const childMode = session.user.role === "child"; this.setData({ id: options.id || "", childMode, canEditCurrent: !options.id, assigneeLabels: childMode ? ["孩子"] : assignees.map((item) => item.label), assigneeIndex: 0, "form.assignee": "child", "form.type": options.type || "daily", "form.date": options.date || formatDate(new Date()), "form.semester": session.family.currentSemester }); if (options.id && !await this.load(options.id)) wx.navigateBack(); },
  async load(id) { try { const item = await callFunction("plan", "get", { id }); if (item.canEdit !== true) { wx.showToast({ title: "只能编辑自己创建的个人计划", icon: "none" }); return false; } const assigneeIndex = Math.max(0, assignees.findIndex((assignee) => assignee.value === item.assignee)); this.setData({ form: { ...item, items: decorateItems(item.items || []) }, canEditCurrent: true, assigneeIndex: this.data.childMode ? 0 : assigneeIndex }); return true; } catch (error) { showError(error); return false; } },
  onInput(event) { this.setData({ [`form.${event.currentTarget.dataset.field}`]: event.detail.value }); },
  onDateChange(event) { this.setData({ "form.date": event.detail.value }); },
  selectType(event) { this.setData({ "form.type": event.currentTarget.dataset.value }); },
  onAssigneeChange(event) { if (this.data.childMode) return; const index = Number(event.detail.value); this.setData({ assigneeIndex: index, "form.assignee": assignees[index].value }); },
  onItemInput(event) { this.setData({ [`form.items[${event.currentTarget.dataset.index}].text`]: event.detail.value }); },
  onPriorityChange(event) { const itemIndex = event.currentTarget.dataset.index; const priorityIndex = Number(event.detail.value); this.setData({ [`form.items[${itemIndex}].priority`]: PRIORITIES[priorityIndex].value, [`form.items[${itemIndex}].priorityIndex`]: priorityIndex }); },
  addItem() { if (this.data.form.items.length >= 30) return; this.setData({ "form.items": [...this.data.form.items, ...decorateItems([{ text: "", isDone: false, priority: "medium" }])] }); },
  removeItem(event) { const items = [...this.data.form.items]; items.splice(event.currentTarget.dataset.index, 1); this.setData({ "form.items": items.length ? items : decorateItems([{ text: "", isDone: false, priority: "medium" }]) }); },
  async save() { if (this.saveInProgress) return; this.saveInProgress = true; this.setData({ submitting: true }); try { const session = await this.refreshPermission(); if (!session) return; if (this.data.id) { const latest = await callFunction("plan", "get", { id: this.data.id }); if (latest.canEdit !== true) { wx.showToast({ title: "只能编辑自己创建的个人计划", icon: "none" }); return; } } const items = this.data.form.items.map(({ text, isDone, priority }) => ({ text, isDone, priority })).filter((item) => item.text.trim()); if (!this.data.form.title.trim() || !items.length) { wx.showToast({ title: "请填写标题和至少一个子任务", icon: "none" }); return; } await callFunction("plan", this.data.id ? "update" : "create", { ...this.data.form, assignee: session.user.role === "child" ? "child" : this.data.form.assignee, id: this.data.id, items }); wx.navigateBack(); } catch (error) { showError(error); } finally { this.saveInProgress = false; this.setData({ submitting: false }); } },
  async remove() { if (!this.data.id || !await this.refreshPermission()) return; const current = await callFunction("plan", "get", { id: this.data.id }).catch((error) => { showError(error); return null; }); if (!current || current.canEdit !== true) { if (current) wx.showToast({ title: "只能删除自己创建的个人计划", icon: "none" }); return; } wx.showModal({ title: "删除计划", content: "删除后无法恢复，确认继续吗？", success: async (result) => { if (!result.confirm) return; if (!await this.refreshPermission()) return; try { const latest = await callFunction("plan", "get", { id: this.data.id }); if (latest.canEdit !== true) { wx.showToast({ title: "只能删除自己创建的个人计划", icon: "none" }); return; } await callFunction("plan", "remove", { id: this.data.id }); wx.navigateBack(); } catch (error) { showError(error); } } }); },
});
