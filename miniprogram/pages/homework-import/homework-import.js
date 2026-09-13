const { callFunction, showError } = require("../../utils/api");
const { requireFamily } = require("../../utils/session");
const { DEFAULT_SUBJECTS } = require("../../utils/constants");
const { canPerform } = require("../../utils/permissions");
const {
  MAX_DRAFTS,
  validateSelectedFiles,
  uploadFileWithCredential,
  createEditableDrafts,
  createHomeworkPayload,
  checkPossibleDuplicates,
} = require("../../utils/ai-import");

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
      const subjectData = await callFunction("settings", "getSubjects");
      if (Array.isArray(subjectData.subjects) && subjectData.subjects.length) subjects = subjectData.subjects;
    } catch (error) {
      console.error("Load AI import subjects failed", { message: error.message });
    }

    try {
      const status = await callFunction("ai", "getStatus");
      if (this.pageDestroyed) return;
      const enabled = status.enabled === true && status.canImport === true;
      this.setData({
        semester: session.family.currentSemester,
        subjects,
        enabled,
        blockedReason: enabled ? "" : status.blockedReason || "AI 作业导入暂不可用",
      });
    } catch (error) {
      if (this.pageDestroyed) return;
      this.setData({
        semester: session.family.currentSemester,
        subjects,
        enabled: false,
        blockedReason: "AI 作业导入状态加载失败，请稍后重试",
      });
      console.error("Load AI import status failed", { message: error.message });
    }
  },

  changeImportScope(event) {
    const importScope = event && event.detail && event.detail.value;
    if (this.data.processing || this.data.saving) return;
    if (!IMPORT_SCOPE_OPTIONS.some((item) => item.value === importScope)) return;
    if (this.data.drafts.some((draft) => !draft.saved)) {
      wx.showToast({ title: "请先处理当前识别草稿", icon: "none" });
      return;
    }
    this.setData({ importScope });
  },

  async chooseScreenshots() {
    if (!canPerform(this.currentUser && this.currentUser.role, "importHomework")) {
      wx.showToast({ title: "孩子账号不能使用 AI 导入", icon: "none" });
      return;
    }
    if (!this.data.enabled) {
      wx.showToast({ title: this.data.blockedReason || "AI 作业导入暂不可用", icon: "none" });
      return;
    }
    if (this.data.processing || this.data.saving) return;
    if (this.data.drafts.some((draft) => !draft.saved)) {
      wx.showToast({ title: "请先处理当前识别草稿", icon: "none" });
      return;
    }

    try {
      const result = await wx.chooseMedia({
        count: 3,
        mediaType: ["image"],
        sourceType: ["album", "camera"],
        sizeType: ["compressed"],
      });
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

  async recognize() {
    if (this.recognizeInProgress || this.data.processing || !this.data.selectedFiles.length) return;
    this.recognizeInProgress = true;
    this.setData({ processing: true });
    let jobId = "";
    try {
      const session = await this.refreshPermission();
      if (!session || this.pageDestroyed) return;
      if (!this.data.enabled) {
        wx.showToast({ title: this.data.blockedReason || "AI 作业导入暂不可用", icon: "none" });
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

      this.setData({ phase: "analyzing", progressText: "AI 正在识别并拆分作业，请稍候…" });
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
        console.error("Check AI import duplicates failed", { message: duplicateResult.error.message });
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
        selectedFiles: [],
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
        showError(error, "AI 作业识别失败");
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
    if (this.saveInProgress || this.data.saving || this.data.processing) return;
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
    } finally {
      this.saveInProgress = false;
      if (!this.pageDestroyed) this.setData({ saving: false });
    }
  },

  updateUnloadGuard() {
    if (this.data.drafts.some((draft) => !draft.saved)) {
      if (typeof wx.enableAlertBeforeUnload === "function") wx.enableAlertBeforeUnload({ message: "还有未保存的 AI 作业草稿，确认离开吗？" });
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
      console.error("Cancel AI import job failed", { stage: "cancel", message: error.message });
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
