const { callFunction, showError } = require("../../utils/api");
const { requireFamily } = require("../../utils/session");
const { DEFAULT_SUBJECTS } = require("../../utils/constants");
const { canPerform } = require("../../utils/permissions");
const { WEEKDAYS, normalizeTimetableEntries } = require("../../utils/timetable");
const { createShareAppMessage, createShareTimelineMessage } = require("../../utils/share");

function validCoordinate(dayOfWeek, period) {
  return Number.isSafeInteger(dayOfWeek) && dayOfWeek >= 1 && dayOfWeek <= 7
    && Number.isSafeInteger(period) && period >= 1 && period <= 12;
}

Page({
  onShareAppMessage: createShareAppMessage,
  onShareTimeline: createShareTimelineMessage,

  data: {
    dayOfWeek: 1,
    dayLabel: "周一",
    period: 1,
    subjects: [],
    version: 0,
    exists: false,
    form: { courseName: "", teacher: "", location: "", startTime: "", endTime: "" },
    hasTime: false,
    initializing: true,
    initializationFailed: false,
    submitting: false,
  },

  async onLoad(options = {}) {
    const dayOfWeek = Number(options.dayOfWeek);
    const period = Number(options.period);
    if (!validCoordinate(dayOfWeek, period)) {
      wx.showToast({ title: "课程位置不正确", icon: "none" });
      wx.navigateBack();
      return;
    }
    this.setData({ dayOfWeek, dayLabel: WEEKDAYS[dayOfWeek - 1].label, period, initializing: true, initializationFailed: false });
    try {
      const session = await this.refreshPermission();
      if (!session) {
        this.setData({ initializationFailed: true });
        if (this.currentUser) wx.navigateBack();
        return;
      }
      let subjects = DEFAULT_SUBJECTS[session.family.educationStage] || DEFAULT_SUBJECTS.junior_high;
      const [subjectResult, timetable] = await Promise.all([
        callFunction("settings", "getSubjects").catch((error) => {
          console.error("Load timetable subjects failed", { message: error.message });
          return { subjects };
        }),
        callFunction("timetable", "get"),
      ]);
      if (Array.isArray(subjectResult.subjects) && subjectResult.subjects.length) subjects = subjectResult.subjects;
      const entries = normalizeTimetableEntries(timetable.entries);
      const entry = entries.find((item) => item.dayOfWeek === dayOfWeek && item.period === period);
      const form = entry ? {
        courseName: entry.courseName,
        teacher: entry.teacher,
        location: entry.location,
        startTime: entry.startTime,
        endTime: entry.endTime,
      } : { courseName: "", teacher: "", location: "", startTime: "", endTime: "" };
      this.setData({
        subjects,
        version: Number.isSafeInteger(timetable.version) && timetable.version >= 0 ? timetable.version : 0,
        exists: Boolean(entry),
        form,
        hasTime: Boolean(form.startTime && form.endTime),
      });
    } catch (error) {
      this.setData({ initializationFailed: true });
      showError(error, "课程信息加载失败");
    } finally {
      this.setData({ initializing: false });
    }
  },

  async refreshPermission() {
    let session;
    try {
      session = await requireFamily();
    } catch (error) {
      this.currentUser = null;
      showError(error, "身份校验失败，请稍后重试");
      return null;
    }
    if (!session) {
      this.currentUser = null;
      return null;
    }
    this.currentUser = session.user;
    if (!canPerform(session.user.role, "manageTimetable")) {
      wx.showToast({ title: "孩子账号不能修改课程表", icon: "none" });
      return null;
    }
    return session;
  },

  isLocked() {
    return this.data.initializing || this.data.initializationFailed || this.data.submitting;
  },

  selectSubject(event) {
    if (this.isLocked()) return;
    const courseName = event.currentTarget.dataset.value;
    if (!this.data.subjects.includes(courseName)) return;
    this.setData({ "form.courseName": courseName });
  },

  onInput(event) {
    if (this.isLocked()) return;
    const field = event.currentTarget.dataset.field;
    if (!["courseName", "teacher", "location"].includes(field)) return;
    this.setData({ [`form.${field}`]: event.detail.value });
  },

  toggleTime(event) {
    if (this.isLocked()) return;
    const hasTime = event.detail.value === true;
    this.setData({
      hasTime,
      "form.startTime": hasTime ? this.data.form.startTime || "08:00" : "",
      "form.endTime": hasTime ? this.data.form.endTime || "08:40" : "",
    });
  },

  onTime(event) {
    if (this.isLocked()) return;
    const field = event.currentTarget.dataset.field;
    if (!["startTime", "endTime"].includes(field)) return;
    this.setData({ [`form.${field}`]: event.detail.value });
  },

  async save() {
    if (this.isLocked() || this.saveInProgress) return;
    const courseName = this.data.form.courseName.trim();
    if (!courseName) {
      wx.showToast({ title: "请填写科目名称", icon: "none" });
      return;
    }
    const entry = {
      dayOfWeek: this.data.dayOfWeek,
      period: this.data.period,
      courseName,
      teacher: this.data.form.teacher,
      location: this.data.form.location,
      startTime: this.data.hasTime ? this.data.form.startTime : "",
      endTime: this.data.hasTime ? this.data.form.endTime : "",
    };
    this.saveInProgress = true;
    this.setData({ submitting: true });
    try {
      if (!await this.refreshPermission()) return;
      await callFunction("timetable", "saveEntry", { expectedVersion: this.data.version, entry });
      wx.showToast({ title: "课程已保存", icon: "success" });
      wx.navigateBack();
    } catch (error) {
      showError(error, "课程保存失败");
    } finally {
      this.saveInProgress = false;
      this.setData({ submitting: false });
    }
  },

  remove() {
    if (this.isLocked() || !this.data.exists) return;
    wx.showModal({
      title: "删除课程",
      content: `确认删除${this.data.dayLabel}第 ${this.data.period} 节课程吗？`,
      success: async (result) => {
        if (!result.confirm || this.deleteInProgress) return;
        this.deleteInProgress = true;
        this.setData({ submitting: true });
        try {
          if (!await this.refreshPermission()) return;
          await callFunction("timetable", "removeEntry", {
            expectedVersion: this.data.version,
            dayOfWeek: this.data.dayOfWeek,
            period: this.data.period,
          });
          wx.showToast({ title: "课程已删除", icon: "success" });
          wx.navigateBack();
        } catch (error) {
          showError(error, "课程删除失败");
        } finally {
          this.deleteInProgress = false;
          this.setData({ submitting: false });
        }
      },
    });
  },
});
