const { callFunction, showError } = require("../../utils/api");
const { requireFamily } = require("../../utils/session");
const { NOTICE_CATEGORIES } = require("../../utils/constants");
const { canPerform } = require("../../utils/permissions");
const {
  validateSelectedFiles,
  uploadFileWithCredential,
} = require("../../utils/ai-import");
const {
  createEditableNoticeDrafts,
  createNoticeDraftTransfer,
  createNoticeBatchPayload,
  mergeNoticeDrafts,
} = require("../../utils/notice-ai-import");
const { createShareAppMessage, createShareTimelineMessage } = require("../../utils/share");

Page({
  onShareAppMessage: createShareAppMessage,
  onShareTimeline: createShareTimelineMessage,

  data: {
    semester: "",
    categories: NOTICE_CATEGORIES,
    selectedFiles: [],
    drafts: [],
    separateDrafts: [],
    mergedDrafts: [],
    draftMode: "separate",
    modeSelectionVisible: false,
    modeLocked: false,
    unsavedCount: 0,
    warnings: [],
    enabled: false,
    blockedReason: "",
    phase: "initial",
    progressText: "",
    processing: false,
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
    if (!canPerform(session.user.role, "importNotice")) {
      wx.showToast({ title: "孩子账号不能使用 AI 导入", icon: "none" });
      wx.navigateBack();
      return null;
    }
    return session;
  },

  async onLoad() {
    this.pageDestroyed = false;
    this.recognizeInProgress = false;
    this.uploadRequestTask = null;
    this.activeJobId = "";
    const session = await this.refreshPermission();
    if (!session || this.pageDestroyed) return;
    try {
      const status = await callFunction("ai", "getStatus");
      if (this.pageDestroyed) return;
      const enabled = status.enabled === true && status.canImport === true;
      this.setData({
        semester: session.family.currentSemester,
        enabled,
        blockedReason: enabled ? "" : status.blockedReason || "AI 通知导入暂不可用",
      });
    } catch (error) {
      if (this.pageDestroyed) return;
      this.setData({
        semester: session.family.currentSemester,
        enabled: false,
        blockedReason: "AI 通知导入状态加载失败，请稍后重试",
      });
      console.error("Load notice AI import status failed", { message: error.message });
    }
  },

  async chooseScreenshots() {
    if (!canPerform(this.currentUser && this.currentUser.role, "importNotice")) {
      wx.showToast({ title: "孩子账号不能使用 AI 导入", icon: "none" });
      return;
    }
    if (!this.data.enabled) {
      wx.showToast({ title: this.data.blockedReason || "AI 通知导入暂不可用", icon: "none" });
      return;
    }
    if (this.data.processing) return;
    if (this.data.drafts.some((draft) => !draft.saved)) {
      wx.showToast({ title: "请先处理当前通知草稿", icon: "none" });
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
      this.setData({
        selectedFiles,
        drafts: [],
        separateDrafts: [],
        mergedDrafts: [],
        draftMode: "separate",
        modeSelectionVisible: false,
        modeLocked: false,
        unsavedCount: 0,
        warnings: [],
        phase: "selected",
        progressText: `已选择 ${selectedFiles.length} 张截图`,
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
      const selectedFiles = this.data.selectedFiles.slice();
      this.setData({ phase: "uploading", progressText: "正在申请临时上传凭据…", warnings: [] });
      const files = selectedFiles.map(({ name, mimeType, size }) => ({ name, mimeType, size }));
      const job = await callFunction("ai", "createImportJob", { files, importType: "notice" });
      if (!job || typeof job.jobId !== "string" || !job.jobId
        || !Array.isArray(job.uploads) || job.uploads.length !== files.length) {
        throw new Error("服务端返回的上传任务不完整");
      }
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
      this.setData({ phase: "analyzing", progressText: "AI 正在识别并拆分通知，请稍候…" });
      const result = await callFunction("ai", "analyzeImportJob", { jobId });
      if (this.activeJobId === jobId) this.activeJobId = "";
      if (this.pageDestroyed) return;
      const drafts = createEditableNoticeDrafts(result.drafts, this.data.semester, jobId);
      if (!drafts.length) throw new Error("没有识别到可确认的通知，请更换清晰截图重试");
      const separateDrafts = drafts.map((draft) => ({ ...draft }));
      const mergedDrafts = drafts.length > 1 ? mergeNoticeDrafts(drafts, jobId) : drafts.map((draft) => ({ ...draft }));
      const draftMode = drafts.length > 1 && selectedFiles.length === 1 ? "single" : "separate";
      const visibleDrafts = (draftMode === "single" ? mergedDrafts : separateDrafts).map((draft) => ({ ...draft }));
      const warnings = Array.isArray(result.warnings)
        ? result.warnings.filter((item) => typeof item === "string" && item.trim()).slice(0, 20)
        : [];
      this.setData({
        selectedFiles: [],
        drafts: visibleDrafts,
        separateDrafts,
        mergedDrafts,
        draftMode,
        modeSelectionVisible: drafts.length > 1,
        modeLocked: false,
        unsavedCount: visibleDrafts.length,
        warnings,
        phase: "ready",
        progressText: draftMode === "single"
          ? `识别到 ${drafts.length} 段内容，已建议整合为 1 条通知，请核对`
          : `已识别 ${drafts.length} 条通知，请逐条核对`,
      });
      this.updateUnloadGuard();
    } catch (error) {
      if (!this.pageDestroyed) {
        await this.cancelActiveJob(jobId);
        this.setData({ phase: "selected", progressText: "识别未完成，可重新发起本次导入" });
        showError(error, "AI 通知识别失败");
      }
    } finally {
      this.recognizeInProgress = false;
      this.uploadRequestTask = null;
      if (!this.pageDestroyed) this.setData({ processing: false });
    }
  },

  onDraftInput(event) {
    const index = Number(event.currentTarget.dataset.index);
    const field = event.currentTarget.dataset.field;
    const draft = this.data.drafts[index];
    if (!draft || draft.saved || this.data.processing || !["title", "source", "content"].includes(field)) return;
    const drafts = this.data.drafts.map((item, itemIndex) => itemIndex === index ? {
      ...item,
      [field]: event.detail.value,
      [`${field}Uncertain`]: false,
      uncertainFields: (item.uncertainFields || []).filter((uncertainField) => uncertainField !== field),
    } : item);
    const groupKey = this.data.draftMode === "single" ? "mergedDrafts" : "separateDrafts";
    this.setData({ drafts, [groupKey]: drafts.map((item) => ({ ...item })) });
  },

  selectCategory(event) {
    const index = Number(event.currentTarget.dataset.index);
    const value = event.currentTarget.dataset.value;
    const draft = this.data.drafts[index];
    const category = NOTICE_CATEGORIES.find((item) => item.value === value);
    if (!draft || draft.saved || this.data.processing || !category) return;
    const drafts = this.data.drafts.map((item, itemIndex) => itemIndex === index ? {
      ...item,
      category: category.value,
      categoryLabel: category.label,
      categoryUncertain: false,
      uncertainFields: (item.uncertainFields || []).filter((uncertainField) => uncertainField !== "category"),
    } : item);
    const groupKey = this.data.draftMode === "single" ? "mergedDrafts" : "separateDrafts";
    this.setData({ drafts, [groupKey]: drafts.map((item) => ({ ...item })) });
  },

  selectDraftMode(event) {
    const draftMode = event.currentTarget.dataset.value;
    if (!this.data.modeSelectionVisible || this.data.processing || !["single", "separate"].includes(draftMode)) return;
    if (this.data.modeLocked || this.data.drafts.some((draft) => draft.saved)) {
      wx.showToast({ title: "已有通知保存，不能再切换保存方式", icon: "none" });
      return;
    }
    const source = draftMode === "single" ? this.data.mergedDrafts : this.data.separateDrafts;
    const drafts = source.map((draft) => ({ ...draft }));
    this.setData({
      draftMode,
      drafts,
      unsavedCount: drafts.filter((draft) => !draft.saved).length,
      progressText: draftMode === "single"
        ? "将保存为 1 条通知，编号内容会保留在通知正文中"
        : `将保存为 ${drafts.length} 条独立通知`,
    });
    this.updateUnloadGuard();
  },

  markDraftSaved(requestId) {
    const drafts = this.data.drafts.map((draft) => draft.requestId === requestId ? { ...draft, saved: true } : draft);
    const groupKey = this.data.draftMode === "single" ? "mergedDrafts" : "separateDrafts";
    this.setData({
      drafts,
      [groupKey]: drafts.map((draft) => ({ ...draft })),
      modeLocked: true,
      unsavedCount: drafts.filter((draft) => !draft.saved).length,
    });
    this.updateUnloadGuard();
  },

  async saveAllDrafts() {
    if (this.data.processing) return;
    let payloads;
    try {
      payloads = createNoticeBatchPayload(this.data.drafts);
    } catch (error) {
      showError(error, "请先补全通知标题");
      return;
    }
    if (!payloads.length) {
      wx.showToast({ title: "当前通知均已保存", icon: "none" });
      return;
    }
    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: `批量保存 ${payloads.length} 条通知`,
        content: "将按当前核对结果保存，默认不启用提醒，也不会自动采用 AI 时间建议。需要提醒或事项时间时，请使用单条通知的高级设置。",
        confirmText: "确认保存",
        success: (result) => resolve(result.confirm === true),
        fail: () => resolve(false),
      });
    });
    if (!confirmed || this.pageDestroyed) return;
    this.setData({ processing: true, phase: "saving", progressText: `正在保存 0/${payloads.length} 条通知…` });
    const failures = [];
    let savedCount = 0;
    try {
      const session = await this.refreshPermission();
      if (!session || this.pageDestroyed) return;
      for (let index = 0; index < payloads.length; index += 1) {
        const payload = payloads[index];
        try {
          await callFunction("notice", "create", payload);
          savedCount += 1;
          this.markDraftSaved(payload.clientRequestId);
        } catch (error) {
          failures.push({ requestId: payload.clientRequestId, message: error.message });
          console.error("Batch save AI notice draft failed", { requestId: payload.clientRequestId, message: error.message });
        }
        if (this.pageDestroyed) return;
        this.setData({ progressText: `正在保存 ${index + 1}/${payloads.length} 条通知…` });
      }
      if (!failures.length) {
        this.disableUnloadGuard();
        wx.showToast({ title: `已保存 ${savedCount} 条通知`, icon: "success" });
        wx.switchTab({ url: "/pages/notice-list/notice-list" });
        return;
      }
      wx.showModal({
        title: "部分通知未保存",
        content: `已保存 ${savedCount} 条，另有 ${failures.length} 条保存失败。已保存项不会重复创建，请检查网络后重试。`,
        showCancel: false,
      });
    } finally {
      if (!this.pageDestroyed) {
        this.setData({
          processing: false,
          phase: "ready",
          progressText: failures.length ? `仍有 ${failures.length} 条通知待保存` : "通知已保存",
        });
      }
    }
  },

  editDraft(event) {
    const index = Number(event.currentTarget.dataset.index);
    const draft = this.data.drafts[index];
    if (!draft || draft.saved || this.data.processing) return;
    let transfer;
    try {
      transfer = createNoticeDraftTransfer(draft);
    } catch (error) {
      showError(error, "通知草稿不完整");
      return;
    }
    wx.navigateTo({
      url: "/pages/notice-edit/notice-edit?source=ai",
      success: ({ eventChannel }) => {
        eventChannel.on("noticeSaved", (payload = {}) => {
          if (payload.requestId !== transfer.requestId || this.pageDestroyed) return;
          this.markDraftSaved(payload.requestId);
        });
        eventChannel.emit("noticeDraft", transfer);
      },
    });
  },

  updateUnloadGuard() {
    if (this.data.drafts.some((draft) => !draft.saved)) {
      if (typeof wx.enableAlertBeforeUnload === "function") {
        wx.enableAlertBeforeUnload({ message: "还有未保存的 AI 通知草稿，确认离开吗？" });
      }
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
      console.error("Cancel notice AI import job failed", { message: error.message });
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
