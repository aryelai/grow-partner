const { callFunction, showError } = require("../../utils/api");
const { requireFamily } = require("../../utils/session");
const { formatDate } = require("../../utils/date");
const { createShareAppMessage, createShareTimelineMessage } = require("../../utils/share");

function currentMonth() { return formatDate(new Date()).slice(0, 7); }
function shiftMonth(value, offset) { const [year, month] = value.split("-").map(Number); const date = new Date(year, month - 1 + offset, 1); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`; }

function buildCalendar(month, checkIns, today) {
  const [year, monthNumber] = month.split("-").map(Number);
  const dayCount = new Date(year, monthNumber, 0).getDate();
  const leadingCount = (new Date(year, monthNumber - 1, 1).getDay() + 6) % 7;
  const recordMap = new Map(checkIns.map((item) => [item.date, item]));
  return {
    leadingBlanks: Array.from({ length: leadingCount }, (_, index) => index),
    calendarDays: Array.from({ length: dayCount }, (_, index) => {
      const day = index + 1; const date = `${month}-${String(day).padStart(2, "0")}`; const record = recordMap.get(date);
      return { day, date, status: record ? record.status : "none", mark: record ? (record.status === "completed" ? "✓" : record.status === "partial" ? "◐" : "×") : "", isToday: date === today };
    }),
  };
}

Page({
  onShareAppMessage: createShareAppMessage,
  onShareTimeline: createShareTimelineMessage,

  data: { id: "", habit: null, month: currentMonth(), weekdays: ["一", "二", "三", "四", "五", "六", "日"], leadingBlanks: [], calendarDays: [], todayItems: [], today: formatDate(new Date()), note: "", photo: "", streak: 0, totalPoints: 0, canManage: false, submitting: false },
  async onLoad(options) { const session = await requireFamily(); if (!session) return; this.familyId = session.user.familyId; this.setData({ id: options.id || "", canManage: session.user.role !== "child" }); await this.load(); },
  async load() {
    try {
      const data = await callFunction("habit", "get", { id: this.data.id, month: this.data.month, today: this.data.today });
      const calendar = buildCalendar(this.data.month, data.checkIns, this.data.today);
      const todayRecord = data.checkIns.find((item) => item.date === this.data.today);
      const todayItems = data.habit.checkInItems.map((item) => ({ ...item, done: todayRecord ? todayRecord.items.some((entry) => entry.name === item.name && entry.done) : false }));
      this.setData({ habit: data.habit, ...calendar, todayItems, note: todayRecord ? todayRecord.note : "", photo: todayRecord ? todayRecord.photo : "", streak: data.streak, totalPoints: data.totalPoints });
    } catch (error) { showError(error, "习惯详情加载失败"); }
  },
  changeMonth(event) { this.setData({ month: shiftMonth(this.data.month, Number(event.currentTarget.dataset.offset)) }); this.load(); },
  onItemsChange(event) { const selected = new Set(event.detail.value); this.setData({ todayItems: this.data.todayItems.map((item) => ({ ...item, done: selected.has(item.name) })) }); },
  onNoteInput(event) { this.setData({ note: event.detail.value }); },
  async checkIn() { this.setData({ submitting: true }); try { await callFunction("habit", "checkIn", { habitId: this.data.id, date: this.data.today, items: this.data.todayItems.map(({ name, done }) => ({ name, done })), photo: this.data.photo, note: this.data.note }); wx.showToast({ title: "打卡已保存", icon: "success" }); await this.load(); } catch (error) { showError(error, "打卡保存失败"); } finally { this.setData({ submitting: false }); } },
  remove() { wx.showModal({ title: "停用习惯", content: "历史打卡会保留，确认停用吗？", success: async (result) => { if (!result.confirm) return; try { await callFunction("habit", "remove", { id: this.data.id }); wx.navigateBack(); } catch (error) { showError(error); } } }); },
});
