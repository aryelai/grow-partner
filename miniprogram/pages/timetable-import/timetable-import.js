const { callFunction, showError } = require("../../utils/api");
const { requireFamily } = require("../../utils/session");
const { DEFAULT_SUBJECTS } = require("../../utils/constants");
const { canPerform } = require("../../utils/permissions");
const { validateSelectedFiles, uploadFileWithCredential } = require("../../utils/ai-import");
const {
  WEEKDAYS,
  PERIODS,
  normalizeTimetableEntries,
  createEditableTimetableDrafts,
  createTimetableEntriesPayload,
} = require("../../utils/timetable");
const { createShareAppMessage, createShareTimelineMessage } = require("../../utils/share");

Page({
  onShareAppMessage: createShareAppMessage,
  onShareTimeline: createShareTimelineMessage,

  data: {
    semester: "",
    days: WEEKDAYS,
    periods: PERIODS,
    subjects: [],
    existingEntries: [],
    version: 0,
    selectedFiles: [],
    drafts: [],
    warnings: [],
    enabled: false,
    blockedReason: "",
    phase: "initial",
    progressText: "",
    processing: false,
    saving: false,
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
    if (!canPerform(session.user.role, "importTimetable")) {
      wx.showToast({ title: "孩子账号不能使用 AI 导入", icon: "none" });
      wx.navigateBack();
      return null;
    }
    return session;
  },

  async onLoad() {
    this.pageDestroyed = false;
    this.recognizeInProgress = false;
    this.saveInProgress = false;
    this.uploadRequestTask = null;
    this.activeJobId = "";
    const session = await this.refreshPermission();
    if (!session || this.pageDestroyed) return;
    let subjects = DEFAULT_SUBJECTS[session.family.educationStage] || DEFAULT_SUBJECTS.junior_high;
    try {
      const [subjectResult, timetable, status] = await Promise.all([
        callFunction("settings", "getSubjects").catch((error) => {
          console.error("Load timetable import subjects failed", { message: error.message });
          return { subjects };
        }),
        callFunction("timetable", "get"),
        callFunction("ai", "getStatus"),
      ]);
      if (Array.isArray(subjectResult.subjects) && subjectResult.subjects.length) subjects = subjectResult.subjects;
      const enabled = status.enabled === true && status.canImport === true;
      this.setData({
        semester: session.family.currentSemester,
        subjects,
        existingEntries: normalizeTimetableEntries(timetable.entries),
        version: Number.isSafeInteger(timetable.version) && timetable.version >= 0 ? timetable.version : 0,
        enabled,
        blockedReason: enabled ? "" : status.blockedReason || "AI 课程表导入暂不可用",
      });
    } catch (error) {
      if (this.pageDestroyed) return;
      this.setData({
        semester: session.family.currentSemester,
        subjects,
        enabled: false,
        blockedReason: "AI 课程表导入状态加载失败，请稍后重试",
      });
      console.error("Load timetable import context failed", { message: error.message });
    }
  },

  async chooseScreenshot() {
    if (!canPerform(this.currentUser && this.currentUser.role, "importTimetable")) {
      wx.showToast({ title: "孩子账号不能使用 AI 导入", icon: "none" });
      return;
    }
    if (!this.data.enabled) {
      wx.showToast({ title: this.data.blockedReason || "AI 课程表导入暂不可用", icon: "none" });
      return;
    }
    if (this.data.processing || this.data.saving) return;
    if (this.data.drafts.length) {
      wx.showToast({ title: "请先处理当前课程草稿", icon: "none" });
      return;
    }
    try {
      const result = await wx.chooseMedia({
        count: 3,
        mediaType: ["image"],
        sourceType: ["album", "camera"],
        sizeType: ["original", "compressed"],
      });
      const selectedFiles = validateSelectedFiles(result.tempFiles);
      this.disableUnloadGuard();
      this.setData({ selectedFiles, drafts: [], warnings: [], phase: "selected", progressText: `已选择 ${selectedFiles.length} 张截图` });
    } catch (error) {
      if (!/cancel/i.test(String(error.errMsg || error.message))) showError(error, "选择截图失败");
    }
  },

  async recognize() {
    if (this.recognizeInProgress || this.data.processing || this.data.saving || !this.data.selectedFiles.length) return;
    this.recognizeInProgress = true;
    this.setData({ processing: true });
    let jobId = "";
    try {
      if (!await this.refreshPermission() || this.pageDestroyed) return;
      const selectedFiles = this.data.selectedFiles.slice();
      const files = selectedFiles.map(({ name, mimeType, size }) => ({ name, mimeType, size }));
      this.setData({ phase: "uploading", progressText: "正在申请临时上传凭据…", warnings: [] });
      const job = await callFunction("ai", "createImportJob", { files, importType: "timetable" });
      if (!job || typeof job.jobId !== "string" || !job.jobId
        || !Array.isArray(job.uploads) || job.uploads.length !== files.length) throw new Error("服务端返回的上传任务不完整");
      jobId = job.jobId;
      this.activeJobId = jobId;
      for (let index = 0; index < selectedFiles.length; index += 1) {
        this.setData({ progressText: `正在上传第 ${index + 1}/${selectedFiles.length} 张截图…` });
        try {
          await uploadFileWithCredential(selectedFiles[index], job.uploads[index], wx, (requestTask) => {
            if (this.pageDestroyed) {
              if (requestTask && typeof requestTask.abort === "function") requestTask.abort();
              return;
            }
            this.uploadRequestTask = requestTask;
          });
        } finally {
          this.uploadRequestTask = null;
        }
        if (this.pageDestroyed) return;
      }
      this.setData({ phase: "analyzing", progressText: "AI 正在逐格识别课程表，请稍候…" });
      const result = await callFunction("ai", "analyzeImportJob", { jobId });
      if (this.activeJobId === jobId) this.activeJobId = "";
      if (this.pageDestroyed) return;
      const drafts = createEditableTimetableDrafts(result.entries, this.data.subjects, this.data.existingEntries, jobId);
      if (!drafts.length) throw new Error("没有识别到可确认的课程，请更换清晰截图重试");
      this.setData({
        selectedFiles: [],
        drafts,
        warnings: Array.isArray(result.warnings) ? result.warnings.filter((item) => typeof item === "string" && item.trim()).slice(0, 20) : [],
        phase: "ready",
        progressText: `已识别 ${drafts.length} 个课程格，请核对后保存`,
      });
      this.updateUnloadGuard();
    } catch (error) {
      if (!this.pageDestroyed) {
        await this.cancelActiveJob(jobId);
        this.setData({ phase: "selected", progressText: "识别未完成，可重新发起本次导入" });
        showError(error, "AI 课程表识别失败");
      }
    } finally {
      this.recognizeInProgress = false;
      this.uploadRequestTask = null;
      if (!this.pageDestroyed) this.setData({ processing: false });
    }
  },

  toggleDraft(event) {
    const index = Number(event.currentTarget.dataset.index);
    const draft = this.data.drafts[index];
    if (!draft || this.data.processing || this.data.saving) return;
    this.setData({ [`drafts[${index}].selected`]: !draft.selected });
  },

  onDraftInput(event) {
    const index = Number(event.currentTarget.dataset.index);
    const field = event.currentTarget.dataset.field;
    const draft = this.data.drafts[index];
    if (!draft || this.data.processing || this.data.saving || !["courseName", "teacher", "location"].includes(field)) return;
    this.setData({
      [`drafts[${index}].${field}`]: event.detail.value,
      [`drafts[${index}].${field}Uncertain`]: false,
      ...(field === "courseName" ? { [`drafts[${index}].customCourse`]: !this.data.subjects.includes(event.detail.value.trim()) } : {}),
      [`drafts[${index}].uncertainFields`]: (draft.uncertainFields || []).filter((item) => item !== field),
    });
  },

  selectSubject(event) {
    const index = Number(event.currentTarget.dataset.index);
    const courseName = event.currentTarget.dataset.value;
    if (!this.data.subjects.includes(courseName) || !this.data.drafts[index] || this.data.saving) return;
    this.setData({
      [`drafts[${index}].courseName`]: courseName,
      [`drafts[${index}].courseNameUncertain`]: false,
      [`drafts[${index}].customCourse`]: false,
      [`drafts[${index}].uncertainFields`]: (this.data.drafts[index].uncertainFields || []).filter((item) => item !== "courseName"),
    });
  },

  onDayChange(event) {
    const index = Number(event.currentTarget.dataset.index);
    const dayIndex = Number(event.detail.value);
    const draft = this.data.drafts[index];
    if (!draft || !WEEKDAYS[dayIndex] || this.data.saving) return;
    const dayOfWeek = WEEKDAYS[dayIndex].value;
    this.setData({
      [`drafts[${index}].dayIndex`]: dayIndex,
      [`drafts[${index}].dayOfWeek`]: dayOfWeek,
      [`drafts[${index}].dayLabel`]: WEEKDAYS[dayIndex].label,
      [`drafts[${index}].uncertainFields`]: (draft.uncertainFields || []).filter((item) => item !== "dayOfWeek"),
    });
    this.refreshConflict(index, dayOfWeek, draft.period);
  },

  onPeriodChange(event) {
    const index = Number(event.currentTarget.dataset.index);
    const periodIndex = Number(event.detail.value);
    const draft = this.data.drafts[index];
    if (!draft || !PERIODS[periodIndex] || this.data.saving) return;
    const period = PERIODS[periodIndex];
    this.setData({
      [`drafts[${index}].periodIndex`]: periodIndex,
      [`drafts[${index}].period`]: period,
      [`drafts[${index}].uncertainFields`]: (draft.uncertainFields || []).filter((item) => item !== "period"),
    });
    this.refreshConflict(index, draft.dayOfWeek, period);
  },

  refreshConflict(index, dayOfWeek, period) {
    const existing = this.data.existingEntries.find((item) => item.dayOfWeek === dayOfWeek && item.period === period);
    this.setData({
      [`drafts[${index}].willReplace`]: Boolean(existing),
      [`drafts[${index}].existingCourseName`]: existing ? existing.courseName : "",
    });
  },

  toggleTime(event) {
    const index = Number(event.currentTarget.dataset.index);
    const draft = this.data.drafts[index];
    if (!draft || this.data.saving) return;
    const hasTime = event.detail.value === true;
    this.setData({
      [`drafts[${index}].hasTime`]: hasTime,
      [`drafts[${index}].startTime`]: hasTime ? draft.startTime || "08:00" : "",
      [`drafts[${index}].endTime`]: hasTime ? draft.endTime || "08:40" : "",
      [`drafts[${index}].timeUncertain`]: false,
      [`drafts[${index}].uncertainFields`]: (draft.uncertainFields || []).filter((item) => item !== "time"),
    });
  },

  onTime(event) {
    const index = Number(event.currentTarget.dataset.index);
    const field = event.currentTarget.dataset.field;
    if (!this.data.drafts[index] || !["startTime", "endTime"].includes(field) || this.data.saving) return;
    this.setData({ [`drafts[${index}].${field}`]: event.detail.value });
  },

  saveSelected() {
    if (this.saveInProgress || this.data.saving || this.data.processing) return;
    let entries;
    try {
      entries = createTimetableEntriesPayload(this.data.drafts.map((draft) => ({
        ...draft,
        startTime: draft.hasTime ? draft.startTime : "",
        endTime: draft.hasTime ? draft.endTime : "",
      })));
    } catch (error) {
      showError(error, "课程草稿不完整");
      return;
    }
    const positions = new Set(this.data.existingEntries.map((item) => `${item.dayOfWeek}:${item.period}`));
    const replacedCount = entries.filter((entry) => positions.has(`${entry.dayOfWeek}:${entry.period}`)).length;
    if (replacedCount) {
      wx.showModal({
        title: "确认替换已有课程",
        content: `选中内容会替换 ${replacedCount} 个同星期同节次的已有课程，其余课程不受影响。确认继续吗？`,
        success: (result) => { if (result.confirm) this.persistEntries(entries); },
      });
      return;
    }
    this.persistEntries(entries);
  },

  async persistEntries(entries) {
    if (this.saveInProgress) return;
    this.saveInProgress = true;
    this.setData({ saving: true });
    try {
      if (!await this.refreshPermission() || this.pageDestroyed) return;
      const result = await callFunction("timetable", "mergeEntries", { expectedVersion: this.data.version, entries });
      this.disableUnloadGuard();
      wx.showToast({ title: `已新增 ${result.addedCount || 0}，替换 ${result.replacedCount || 0}`, icon: "success" });
      wx.navigateBack();
    } catch (error) {
      showError(error, "课程表保存失败");
    } finally {
      this.saveInProgress = false;
      if (!this.pageDestroyed) this.setData({ saving: false });
    }
  },

  updateUnloadGuard() {
    if (this.data.drafts.length) {
      if (typeof wx.enableAlertBeforeUnload === "function") wx.enableAlertBeforeUnload({ message: "还有未保存的 AI 课程表草稿，确认离开吗？" });
      return;
    }
    this.disableUnloadGuard();
  },

  disableUnloadGuard() {
    if (typeof wx.disableAlertBeforeUnload === "function") wx.disableAlertBeforeUnload();
  },

  async cancelActiveJob(jobId = this.activeJobId) {
    if (!jobId) return;
    if (this.activeJobId === jobId) this.activeJobId = "";
    try {
      await callFunction("ai", "cancelImportJob", { jobId });
    } catch (error) {
      console.error("Cancel timetable AI import job failed", { message: error.message });
    }
  },

  onUnload() {
    this.pageDestroyed = true;
    const requestTask = this.uploadRequestTask;
    this.uploadRequestTask = null;
    if (requestTask && typeof requestTask.abort === "function") requestTask.abort();
    this.disableUnloadGuard();
    this.cancelActiveJob();
  },
});
