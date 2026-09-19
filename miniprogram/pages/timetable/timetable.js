const { callFunction, showError } = require("../../utils/api");
const { requireFamily } = require("../../utils/session");
const { canPerform } = require("../../utils/permissions");
const { WEEKDAYS, normalizeTimetableEntries, normalizeTimetableOverrides, createDaySlots, createDateSlots } = require("../../utils/timetable");
const { getBeijingDate, shiftIsoDate, formatHomeworkDate } = require("../../utils/date");
const { GUEST_SEMESTER_LABEL, createGuestTimetableEntries, requestFamilyAccess } = require("../../utils/guest-experience");
const { createShareAppMessage, createShareTimelineMessage } = require("../../utils/share");

function getTodayWeekday() {
  const day = new Date().getDay();
  return day === 0 ? 7 : day;
}

const INITIAL_DAY = getTodayWeekday();
const INITIAL_DATE = getBeijingDate(new Date());

Page({
  onShareAppMessage: createShareAppMessage,
  onShareTimeline: createShareTimelineMessage,

  data: {
    semester: "",
    days: WEEKDAYS,
    selectedDay: INITIAL_DAY,
    selectedDate: INITIAL_DATE,
    dateLabel: formatHomeworkDate(INITIAL_DATE),
    viewMode: "week",
    entries: [],
    overrides: [],
    slots: createDaySlots([], INITIAL_DAY),
    version: 0,
    loading: true,
    canManage: false,
    canUseImport: false,
    canImport: false,
    importBlockedReason: "",
    guestMode: false,
  },

  async onShow() {
    let session;
    try {
      session = await requireFamily({ redirect: false });
    } catch (error) {
      console.error("Load timetable session failed", { message: error.message });
      this.enterGuestMode();
      showError(error, "身份校验失败，请稍后重试");
      return;
    }
    if (!session) {
      this.enterGuestMode();
      return;
    }
    this.currentUser = session.user;
    const canManage = canPerform(session.user.role, "manageTimetable");
    const canUseImport = canPerform(session.user.role, "importTimetable");
    this.setData({
      semester: session.family.currentSemester,
      canManage,
      canUseImport,
      canImport: false,
      importBlockedReason: canUseImport ? "正在检查智能导入服务" : "",
      guestMode: false,
    });
    const timetableLoad = this.load();
    let canImport = false;
    let importBlockedReason = "课程表智能导入暂不可用";
    if (canUseImport) {
      try {
        const status = await callFunction("ai", "getStatus");
        canImport = status.enabled === true && status.canImport === true;
        importBlockedReason = canImport ? "" : status.blockedReason || importBlockedReason;
      } catch (error) {
        importBlockedReason = "课程表智能导入状态加载失败，请稍后重试";
        console.error("Load timetable image import status failed", { message: error.message });
      }
    }
    this.setData({ canImport, importBlockedReason });
    await timetableLoad;
  },

  enterGuestMode() {
    this.currentUser = null;
    const entries = normalizeTimetableEntries(createGuestTimetableEntries());
    this.setData({
      semester: GUEST_SEMESTER_LABEL,
      selectedDay: 1,
      viewMode: "week",
      entries,
      overrides: [],
      slots: createDaySlots(entries, 1),
      version: 0,
      loading: false,
      canManage: false,
      canUseImport: false,
      canImport: false,
      importBlockedReason: "",
      guestMode: true,
    });
  },

  async load() {
    if (this.data.guestMode) return;
    this.setData({ loading: true });
    try {
      const result = await callFunction("timetable", "get");
      const entries = normalizeTimetableEntries(result.entries);
      const overrides = normalizeTimetableOverrides(result.overrides);
      this.setData({
        semester: /^\d{4}(上|下)$/.test(String(result.semester)) ? result.semester : this.data.semester,
        entries,
        overrides,
        slots: this.data.viewMode === "date"
          ? createDateSlots(entries, overrides, this.data.selectedDate)
          : createDaySlots(entries, this.data.selectedDay),
        version: Number.isSafeInteger(result.version) && result.version >= 0 ? result.version : 0,
      });
    } catch (error) {
      if (!this.data.slots.length) {
        this.setData({ slots: createDaySlots(this.data.entries, this.data.selectedDay) });
      }
      showError(error, "课程表加载失败");
    } finally {
      this.setData({ loading: false });
    }
  },

  selectDay(event) {
    const selectedDay = Number(event.currentTarget.dataset.value);
    if (!WEEKDAYS.some((item) => item.value === selectedDay)) return;
    this.setData({ selectedDay, slots: createDaySlots(this.data.entries, selectedDay) });
  },

  selectMode(event) {
    const viewMode = event.currentTarget.dataset.value;
    if (!['week', 'date'].includes(viewMode)) return;
    this.setData({
      viewMode,
      slots: viewMode === "date"
        ? createDateSlots(this.data.entries, this.data.overrides, this.data.selectedDate)
        : createDaySlots(this.data.entries, this.data.selectedDay),
    });
  },

  changeDate(event) {
    const offset = Number(event.currentTarget.dataset.offset);
    if (!Number.isInteger(offset) || ![-1, 1].includes(offset)) return;
    this.applyDate(shiftIsoDate(this.data.selectedDate, offset));
  },

  onDateChange(event) { this.applyDate(event.detail.value); },

  applyDate(selectedDate) {
    let dateLabel;
    try { dateLabel = formatHomeworkDate(selectedDate); }
    catch (error) { return; }
    if (dateLabel === "日期待补充") return;
    this.setData({
      selectedDate,
      dateLabel,
      slots: createDateSlots(this.data.entries, this.data.overrides, selectedDate),
    });
  },

  openSlot(event) {
    const period = Number(event.currentTarget.dataset.period);
    const slot = this.data.slots.find((item) => item.period === period);
    if (!slot) return;
    if (this.data.guestMode) {
      if (slot.entry) {
        const detail = [slot.entry.teacher, slot.entry.location, slot.entry.startTime && `${slot.entry.startTime}–${slot.entry.endTime}`].filter(Boolean).join(" · ");
        wx.showModal({ title: `第 ${period} 节 · ${slot.entry.courseName}`, content: detail || "本地课程表示例", showCancel: false, confirmText: "知道了" });
      } else requestFamilyAccess("登录后可维护家庭课程表。", wx);
      return;
    }
    if (!canPerform(this.currentUser && this.currentUser.role, "manageTimetable")) return;
    const dateQuery = this.data.viewMode === "date" ? `&date=${this.data.selectedDate}` : "";
    const dayOfWeek = this.data.viewMode === "date"
      ? (new Date(`${this.data.selectedDate}T00:00:00.000Z`).getUTCDay() || 7)
      : this.data.selectedDay;
    wx.navigateTo({ url: `/pages/timetable-edit/timetable-edit?dayOfWeek=${dayOfWeek}&period=${period}${dateQuery}` });
  },

  importTimetable() {
    if (this.data.guestMode) {
      requestFamilyAccess("登录后可识别课程表截图并整理课程草稿。", wx);
      return;
    }
    if (!canPerform(this.currentUser && this.currentUser.role, "importTimetable")) {
      wx.showToast({ title: "孩子账号不能使用智能导入", icon: "none" });
      return;
    }
    if (!this.data.canImport) {
      wx.showModal({ title: "智能导入暂不可用", content: this.data.importBlockedReason || "请稍后重试", showCancel: false });
      return;
    }
    wx.navigateTo({ url: "/pages/timetable-import/timetable-import" });
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },
});
