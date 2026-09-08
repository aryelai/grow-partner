const { callFunction, showError } = require("../../utils/api");
const { requireFamily } = require("../../utils/session");
const { PLAN_TYPES, PRIORITIES } = require("../../utils/constants");
const { formatDate } = require("../../utils/date");

const assignees = [{ value: "child", label: "孩子" }, { value: "father", label: "爸爸" }, { value: "mother", label: "妈妈" }, { value: "all", label: "全家" }];

function decorateItems(items) {
  return items.map((item) => ({ ...item, priorityIndex: Math.max(0, PRIORITIES.findIndex((priority) => priority.value === item.priority)) }));
}

Page({
  data: { id: "", types: PLAN_TYPES, priorityLabels: PRIORITIES.map((item) => item.label), assigneeLabels: assignees.map((item) => item.label), assigneeIndex: 0, form: { type: "daily", date: formatDate(new Date()), semester: "2026下", title: "", items: decorateItems([{ text: "", isDone: false, priority: "medium" }]), assignee: "child", notes: "", linkedHomeworkIds: [], linkedHabitIds: [] }, submitting: false },
  async onLoad(options) { const session = await requireFamily(); if (!session) return; this.setData({ id: options.id || "", "form.type": options.type || "daily", "form.date": options.date || formatDate(new Date()), "form.semester": session.family.currentSemester }); if (options.id) await this.load(options.id); },
  async load(id) { try { const item = await callFunction("plan", "get", { id }); this.setData({ form: { ...item, items: decorateItems(item.items || []) }, assigneeIndex: Math.max(0, assignees.findIndex((assignee) => assignee.value === item.assignee)) }); } catch (error) { showError(error); } },
  onInput(event) { this.setData({ [`form.${event.currentTarget.dataset.field}`]: event.detail.value }); },
  onDateChange(event) { this.setData({ "form.date": event.detail.value }); },
  selectType(event) { this.setData({ "form.type": event.currentTarget.dataset.value }); },
  onAssigneeChange(event) { const index = Number(event.detail.value); this.setData({ assigneeIndex: index, "form.assignee": assignees[index].value }); },
  onItemInput(event) { this.setData({ [`form.items[${event.currentTarget.dataset.index}].text`]: event.detail.value }); },
  onPriorityChange(event) { const itemIndex = event.currentTarget.dataset.index; const priorityIndex = Number(event.detail.value); this.setData({ [`form.items[${itemIndex}].priority`]: PRIORITIES[priorityIndex].value, [`form.items[${itemIndex}].priorityIndex`]: priorityIndex }); },
  addItem() { if (this.data.form.items.length >= 30) return; this.setData({ "form.items": [...this.data.form.items, ...decorateItems([{ text: "", isDone: false, priority: "medium" }])] }); },
  removeItem(event) { const items = [...this.data.form.items]; items.splice(event.currentTarget.dataset.index, 1); this.setData({ "form.items": items.length ? items : decorateItems([{ text: "", isDone: false, priority: "medium" }]) }); },
  async save() { const items = this.data.form.items.map(({ text, isDone, priority }) => ({ text, isDone, priority })).filter((item) => item.text.trim()); if (!this.data.form.title.trim() || !items.length) { wx.showToast({ title: "请填写标题和至少一个子任务", icon: "none" }); return; } this.setData({ submitting: true }); try { await callFunction("plan", this.data.id ? "update" : "create", { ...this.data.form, id: this.data.id, items }); wx.navigateBack(); } catch (error) { showError(error); } finally { this.setData({ submitting: false }); } },
  remove() { wx.showModal({ title: "删除计划", content: "删除后无法恢复，确认继续吗？", success: async (result) => { if (!result.confirm) return; try { await callFunction("plan", "remove", { id: this.data.id }); wx.navigateBack(); } catch (error) { showError(error); } } }); },
});
