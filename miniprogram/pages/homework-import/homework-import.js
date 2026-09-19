const { callFunction, showError } = require("../../utils/api");
const { requireFamily } = require("../../utils/session");
const { DEFAULT_SUBJECTS } = require("../../utils/constants");
const { canPerform } = require("../../utils/permissions");
const { formatHomeworkDate } = require("../../utils/date");
const {
  MAX_DRAFTS,
  validateSelectedFiles,
  prepareEditedImage,
  uploadFileWithCredential,
  createEditableDrafts,
  createHomeworkPayload,
  checkPossibleDuplicates,
} = require("../../utils/ai-import");
const { createShareAppMessage, createShareTimelineMessage } = require("../../utils/share");

const IMPORT_SCOPE_OPTIONS = [
  { value: "auto", label: "智能判断" },
  { value: "monday", label: "星期一" },
  { value: "tuesday", label: "星期二" },
  { value: "wednesday", label: "星期三" },
  { value: "thursday", label: "星期四" },
  { value: "friday_weekend", label: "星期五/周末" },
  { value: "full_week", label: "整周" },
];

Page({
  onShareAppMessage: createShareAppMessage,
  onShareTimeline: createShareTimelineMessage,

  data: {
    semester: "",
    subjects: [],
    selectedFiles: [],
    drafts: [],
    warnings: [],
    importScope: "auto",
    importScopes: IMPORT_SCOPE_OPTIONS,
    summary: null,
    enabled: false,
    blockedReason: "",
    phase: "initial",
    progressText: "",
    saveProgress: "",
    processing: false,
    saving: false,
    editingImage: false,
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
    if (!canPerform(session.user.role, "importHomework")) {
      wx.showToast({ title: "孩子账号不能使用智能导入", icon: "none" });
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
      const subjectData = await callFunction("settings", "getSubjects");
      if (Array.isArray(subjectData.subjects) && subjectData.subjects.length) subjects = subjectData.subjects;
    } catch (error) {
      console.error("Load image import subjects failed", { message: error.message });
    }

    try {
      const status = await callFunction("ai", "getStatus");
      if (this.pageDestroyed) return;
      const enabled = status.enabled === true && status.canImport === true;
      this.setData({
        semester: session.family.currentSemester,
        subjects,
        enabled,
        blockedReason: enabled ? "" : status.blockedReason || "作业智能导入暂不可用",
      });
    } catch (error) {
      if (this.pageDestroyed) return;
      this.setData({
        semester: session.family.currentSemester,
        subjects,
        enabled: false,
        blockedReason: "作业智能导入状态加载失败，请稍后重试",
      });
      console.error("Load image import status failed", { message: error.message });
    }
  },

  changeImportScope(event) {
    const importScope = event && event.detail && event.detail.value;
    if (this.data.processing || this.data.saving || this.data.editingImage) return;
    if (!IMPORT_SCOPE_OPTIONS.some((item) => item.value === importScope)) return;
    if (this.data.drafts.some((draft) => !draft.saved)) {
      wx.showToast({ title: "请先处理当前识别草稿", icon: "none" });
      return;
    }
    this.setData({ importScope });
  },

  async chooseScreenshots() {
    if (!canPerform(this.currentUser && this.currentUser.role, "importHomework")) {
      wx.showToast({ title: "孩子账号不能使用智能导入", icon: "none" });
      return;
    }
    if (!this.data.enabled) {
      wx.showToast({ title: this.data.blockedReason || "作业智能导入暂不可用", icon: "none" });
      return;
    }
    if (this.data.processing || this.data.saving || this.data.editingImage) return;
    if (this.data.drafts.some((draft) => !draft.saved)) {
      wx.showToast({ title: "请先处理当前识别草稿", icon: "none" });
      return;
    }

    try {
      const result = await wx.chooseMedia({
        count: 3,
        mediaType: ["image"],
        sourceType: ["album", "camera"],
        sizeType: ["original"],
      });
      if (this.pageDestroyed) return;
      const selectedFiles = validateSelectedFiles(result.tempFiles);
      this.disableUnloadGuard();
      this.setData({
        selectedFiles,
        drafts: [],
        warnings: [],
        summary: null,
        phase: "selected",
        progressText: `已选择 ${selectedFiles.length} 张截图`,
        saveProgress: "",
      });
    } catch (error) {
      if (!/cancel/i.test(String(error.errMsg || error.message))) showError(error, "选择截图失败");
    }
  },

  async cropScreenshot(event) {
    const index = Number(event.currentTarget.dataset.index);
    if (!Number.isInteger(index) || !this.data.selectedFiles[index] || this.data.processing || this.data.saving || this.data.editingImage || this.pageDestroyed) return;
    if (!canPerform(this.currentUser && this.currentUser.role, "importHomework")) return;
    if (this.data.drafts.some((draft) => !draft.saved)) { wx.showToast({ title: "请先处理当前识别草稿", icon: "none" }); return; }
    if (typeof wx.editImage !== "function") { wx.showToast({ title: "请在相册中裁剪后重新选择", icon: "none" }); return; }
    this.setData({ editingImage: true });
    try {
      const result = await new Promise((resolve, reject) => wx.editImage({ src: this.data.selectedFiles[index].tempFilePath, success: resolve, fail: reject }));
      if (this.pageDestroyed) return;
      const edited = await prepareEditedImage(result.tempFilePath, index, wx);
      if (this.pageDestroyed) return;
      const selectedFiles = this.data.selectedFiles.slice();
      selectedFiles[index] = edited;
      this.setData({ selectedFiles, drafts: [], warnings: [], summary: null, phase: "selected", progressText: "已裁剪，请保留科目、星期和完整字迹后开始识别", saveProgress: "" });
    } catch (error) {
      if (!this.pageDestroyed && !/cancel/i.test(String(error.errMsg || error.message))) showError(error, "图片编辑失败，原图已保留");
    } finally {
      if (!this.pageDestroyed) this.setData({ editingImage: false });
    }
  },

  async recognize() {
    if (this.recognizeInProgress || this.data.processing || this.data.saving || this.data.editingImage || !this.data.selectedFiles.length) return;
    this.recognizeInProgress = true;
    this.setData({ processing: true });
    let jobId = "";
    try {
      const session = await this.refreshPermission();
      if (!session || this.pageDestroyed) return;
      if (!this.data.enabled) {
        wx.showToast({ title: this.data.blockedReason || "作业智能导入暂不可用", icon: "none" });
        return;
      }

      const selectedFiles = this.data.selectedFiles.slice();
      this.setData({ phase: "uploading", progressText: "正在申请临时上传凭据…", warnings: [], saveProgress: "" });
      const files = selectedFiles.map(({ name, mimeType, size }) => ({ name, mimeType, size }));
      const job = await callFunction("ai", "createImportJob", {
        files,
        importScope: this.data.importScope,
      });
      if (!job || typeof job.jobId !== "string" || !job.jobId) {
        throw new Error("服务端返回的上传任务不完整");
      }
      jobId = job.jobId;
      this.activeJobId = jobId;
      if (!Array.isArray(job.uploads) || job.uploads.length !== files.length) throw new Error("服务端返回的上传任务不完整");
      if (this.pageDestroyed) {
        await this.cancelActiveJob(jobId);
        return;
      }
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

      this.setData({ phase: "analyzing", progressText: "正在识别并整理作业，请稍候…" });
      const result = await callFunction("ai", "analyzeImportJob", { jobId });
      if (this.activeJobId === jobId) this.activeJobId = "";
      if (this.pageDestroyed) return;
      const drafts = createEditableDrafts(result.drafts, this.data.subjects, this.data.semester, jobId);
      if (!drafts.length) throw new Error("没有识别到可确认的作业，请更换清晰截图重试");
      this.setData({ phase: "checking", progressText: "正在检查可能重复的作业…" });
      const duplicateResult = await checkPossibleDuplicates(
        drafts,
        this.data.semester,
        (input) => callFunction("homework", "list", input),
      );
      if (duplicateResult.error) {
        console.error("Check image import duplicates failed", { message: duplicateResult.error.message });
      }
      if (this.pageDestroyed) return;
      const warnings = Array.isArray(result.warnings)
        ? result.warnings.filter((item) => typeof item === "string" && item.trim()).slice(0, 20)
        : [];
      if (Array.isArray(result.drafts) && result.drafts.length > MAX_DRAFTS) {
        warnings.push(`客户端一次最多展示 ${MAX_DRAFTS} 条作业，其余结果已截断`);
      }
      if (duplicateResult.warning) warnings.push(duplicateResult.warning);
      const summary = result.summary && typeof result.summary === "object"
        ? {
          sourceType: String(result.summary.sourceType || "unknown").slice(0, 20),
          sourceTypeLabel: String(result.summary.sourceTypeLabel || "未知版式").slice(0, 20),
          scopeLabel: String(result.summary.scopeLabel || "自动判断").slice(0, 20),
          weekLabel: String(result.summary.weekLabel || "").slice(0, 20),
        }
        : { sourceType: "unknown", sourceTypeLabel: "未知版式", scopeLabel: "自动判断", weekLabel: "" };
      this.setData({
        drafts: duplicateResult.drafts,
        warnings,
        summary,
        phase: "ready",
        progressText: `已识别 ${drafts.length} 条作业，请逐条核对`,
      });
      this.updateUnloadGuard();
    } catch (error) {
      if (!this.pageDestroyed) {
        await this.cancelActiveJob(jobId);
        this.setData({ phase: "selected", progressText: "识别未完成，可重新发起本次导入" });
        showError(error, "作业图片识别失败");
      }
    } finally {
      this.recognizeInProgress = false;
      this.uploadRequestTask = null;
      if (!this.pageDestroyed) this.setData({ processing: false });
    }
  },

  previewSourceImage(event) {
    const current = event.currentTarget.dataset.url;
    const urls = this.data.selectedFiles.map((item) => item.tempFilePath).filter(Boolean);
    if (current && urls.includes(current)) wx.previewImage({ current, urls });
  },

  toggleDraft(event) {
    const index = Number(event.currentTarget.dataset.index);
    const draft = this.data.drafts[index];
    if (!draft || draft.saved || this.data.saving) return;
    this.setData({ [`drafts[${index}].selected`]: !draft.selected });
  },

  onDraftInput(event) {
    const index = Number(event.currentTarget.dataset.index);
    const field = event.currentTarget.dataset.field;
    const draft = this.data.drafts[index];
    if (!draft || draft.saved || this.data.saving || !["title", "content", "extraRequirement"].includes(field)) return;
    const uncertainFields = Array.isArray(draft.uncertainFields) ? draft.uncertainFields : [];
    this.setData({
      [`drafts[${index}].${field}`]: event.detail.value,
      [`drafts[${index}].${field}Uncertain`]: false,
      [`drafts[${index}].uncertainFields`]: uncertainFields.filter((item) => item !== field),
      [`drafts[${index}].possibleDuplicate`]: false,
      [`drafts[${index}].saveError`]: "",
    });
  },

  selectSubject(event) {
    const index = Number(event.currentTarget.dataset.index);
    const draft = this.data.drafts[index];
    const subject = event.currentTarget.dataset.value;
    if (!draft || draft.saved || this.data.saving || !this.data.subjects.includes(subject)) return;
    const uncertainFields = Array.isArray(draft.uncertainFields) ? draft.uncertainFields : [];
    this.setData({
      [`drafts[${index}].subject`]: subject,
      [`drafts[${index}].subjectUncertain`]: false,
      [`drafts[${index}].uncertainFields`]: uncertainFields.filter((item) => item !== "subject"),
      [`drafts[${index}].possibleDuplicate`]: false,
      [`drafts[${index}].saveError`]: "",
    });
  },

  onHomeworkDate(event) {
    const index = Number(event.currentTarget.dataset.index);
    const draft = this.data.drafts[index];
    if (!draft || draft.saved || this.data.saving) return;
    this.setData({
      [`drafts[${index}].homeworkDate`]: event.detail.value,
      [`drafts[${index}].homeworkDateText`]: formatHomeworkDate(event.detail.value),
      [`drafts[${index}].dateSource`]: "manual",
      [`drafts[${index}].homeworkDateUncertain`]: false,
      [`drafts[${index}].uncertainFields`]: (draft.uncertainFields || []).filter((field) => field !== "homeworkDate"),
      [`drafts[${index}].possibleDuplicate`]: false,
      [`drafts[${index}].saveError`]: "",
    });
  },

  onDeadlineSwitch(event) {
    const index = Number(event.currentTarget.dataset.index);
    const draft = this.data.drafts[index];
    if (!draft || draft.saved || this.data.saving) return;
    const uncertainFields = Array.isArray(draft.uncertainFields) ? draft.uncertainFields : [];
    const changes = {
      [`drafts[${index}].hasDeadline`]: event.detail.value === true,
      [`drafts[${index}].deadlineUncertain`]: false,
      [`drafts[${index}].uncertainFields`]: uncertainFields.filter((item) => item !== "deadline"),
    };
    if (event.detail.value === true && (!draft.deadlineDate || !draft.deadlineTime)) {
      const now = new Date();
      const pad = (value) => String(value).padStart(2, "0");
      changes[`drafts[${index}].deadlineDate`] = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      changes[`drafts[${index}].deadlineTime`] = "20:00";
    }
    this.setData(changes);
  },

  onDeadlineDate(event) {
    const index = Number(event.currentTarget.dataset.index);
    const draft = this.data.drafts[index];
    if (!draft || draft.saved || this.data.saving) return;
    const uncertainFields = Array.isArray(draft.uncertainFields) ? draft.uncertainFields : [];
    this.setData({
      [`drafts[${index}].deadlineDate`]: event.detail.value,
      [`drafts[${index}].deadlineUncertain`]: false,
      [`drafts[${index}].uncertainFields`]: uncertainFields.filter((item) => item !== "deadline"),
    });
  },

  onDeadlineTime(event) {
    const index = Number(event.currentTarget.dataset.index);
    const draft = this.data.drafts[index];
    if (!draft || draft.saved || this.data.saving) return;
    const uncertainFields = Array.isArray(draft.uncertainFields) ? draft.uncertainFields : [];
    this.setData({
      [`drafts[${index}].deadlineTime`]: event.detail.value,
      [`drafts[${index}].deadlineUncertain`]: false,
      [`drafts[${index}].uncertainFields`]: uncertainFields.filter((item) => item !== "deadline"),
    });
  },

  async saveSelected() {
    if (this.saveInProgress || this.returningToHomework || this.data.saving || this.data.processing || this.data.editingImage) return;
    this.saveInProgress = true;
    this.setData({ saving: true });
    try {
      const selectedIndexes = this.data.drafts
        .map((draft, index) => (draft.selected && !draft.saved ? index : -1))
        .filter((index) => index >= 0);
      if (!selectedIndexes.length) {
        wx.showToast({ title: "请至少勾选一条未保存作业", icon: "none" });
        return;
      }
      if (!await this.refreshPermission() || this.pageDestroyed) return;

      this.setData({ saveProgress: `准备保存 ${selectedIndexes.length} 条作业…` });
      let savedCount = 0;
      let failedCount = 0;
      const drafts = this.data.drafts.map((draft) => ({ ...draft }));
      for (let offset = 0; offset < selectedIndexes.length; offset += 1) {
        if (this.pageDestroyed) return;
        const index = selectedIndexes[offset];
        drafts[index].saveError = "";
        this.setData({ drafts, saveProgress: `正在保存第 ${offset + 1}/${selectedIndexes.length} 条…` });
        try {
          const payload = createHomeworkPayload(drafts[index]);
          await callFunction("homework", "create", payload);
          if (this.pageDestroyed) return;
          drafts[index].saved = true;
          drafts[index].selected = false;
          savedCount += 1;
        } catch (error) {
          if (this.pageDestroyed) return;
          drafts[index].saveError = error && error.message ? error.message : "作业保存失败，请重试";
          failedCount += 1;
        }
        this.setData({ drafts });
      }

      const saveProgress = failedCount ? `已保存 ${savedCount} 条，${failedCount} 条失败` : `已保存 ${savedCount} 条作业`;
      this.setData({ saveProgress });
      this.updateUnloadGuard();
      wx.showToast({ title: failedCount ? "部分作业保存失败" : "选中作业已保存", icon: failedCount ? "none" : "success" });
      if (!failedCount) {
        const remaining = drafts.filter((draft) => !draft.saved).length;
        if (remaining) {
          wx.showModal({
            title: "选中作业已保存",
            content: `还有 ${remaining} 条未选择的草稿不会保存。返回作业列表，还是继续编辑？`,
            confirmText: "返回作业",
            cancelText: "继续编辑",
            success: (result) => { if (result.confirm && !this.pageDestroyed) this.returnToHomework(); },
          });
        } else this.returnToHomework();
      }
    } finally {
      this.saveInProgress = false;
      if (!this.pageDestroyed) this.setData({ saving: false });
    }
  },

  returnToHomework() {
    if (this.data.processing || this.returningToHomework || this.pageDestroyed) return;
    const dates = this.data.drafts.filter((draft) => draft.saved).map((draft) => draft.homeworkDate).sort();
    if (!dates.length) return;
    this.returningToHomework = true;
    getApp().globalData.homeworkEntry = { date: dates[dates.length - 1] };
    this.disableUnloadGuard();
    wx.switchTab({
      url: "/pages/homework-list/homework-list",
      fail: (error) => { this.returningToHomework = false; this.updateUnloadGuard(); showError(error, "作业已保存，返回列表失败，请手动返回"); },
    });
  },

  updateUnloadGuard() {
    if (this.data.drafts.some((draft) => !draft.saved)) {
      if (typeof wx.enableAlertBeforeUnload === "function") wx.enableAlertBeforeUnload({ message: "还有未保存的作业识别草稿，确认离开吗？" });
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
      console.error("Cancel image import job failed", { stage: "cancel", message: error.message });
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
