const { callFunction, showError } = require("../../utils/api");
const { requireFamily } = require("../../utils/session");
const { EDUCATION_STAGES } = require("../../utils/constants");
const { getAdjacentSemester, formatDate } = require("../../utils/date");
const { formatInviteCode } = require("../../utils/invite-code");
const { requestReminderSubscription } = require("../../utils/subscription");
const { createShareAppMessage, createShareTimelineMessage } = require("../../utils/share");

const EXPORT_DATASETS = ["members", "homework", "notices", "habits", "habit_checkins", "habit_points", "habit_rewards", "plans", "subjects", "timetables", "settings"];

const SENSITIVE_ERROR_VALUE_PATTERN = /((?:^|[{\s,?&;])(?:["'])?(?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|client[_-]?secret|password|cookie|openid|secret|key)(?:["'])?\s*[:=]\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,;}&]+)/gi;

function getReminderStatusPresentation(reminderStatus) {
  if (reminderStatus && reminderStatus.blockedReason === "SYSTEM_BLOCKED") return { text: "提醒功能已阻断", detail: "微信订阅消息能力或模板已停用，请联系管理员处理" };
  if (reminderStatus && reminderStatus.enabled) return { text: "提醒功能已启用", detail: "可增加提醒次数以接收待发送提醒" };
  if (reminderStatus && reminderStatus.blockedReason === "CONFIGURATION") return { text: "提醒功能未启用", detail: "提醒服务尚未配置，暂不能增加提醒次数" };
  if (reminderStatus && reminderStatus.blockedReason === "STATUS_UNAVAILABLE") return { text: "提醒状态暂不可用", detail: "暂时无法读取提醒状态，请重新查询后再授权" };
  return { text: "提醒功能暂不可用", detail: "当前无法增加提醒次数，请稍后重新查询" };
}

function createUnavailableReminderStatus() {
  return { enabled: false, templateId: "", estimatedAvailableCount: 0, pendingCount: 0, blockedReason: "STATUS_UNAVAILABLE" };
}

function cleanErrorText(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(SENSITIVE_ERROR_VALUE_PATTERN, "$1[REDACTED]")
    .replace(/\bo[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
    .trim()
    .slice(0, 160);
}

function cleanErrorCode(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : cleanErrorText(value);
}

function getErrorContext(error) {
  return {
    message: cleanErrorText(error && error.message),
    errMsg: cleanErrorText(error && error.errMsg),
    code: cleanErrorCode(error && error.code),
    errCode: cleanErrorCode(error && error.errCode),
  };
}

function createDisplayError(context) {
  const error = new Error(context.message || context.errMsg);
  error.errMsg = context.errMsg;
  error.code = context.code;
  error.errCode = context.errCode;
  return error;
}

Page({
  onShareAppMessage: createShareAppMessage,
  onShareTimeline: createShareTimelineMessage,

  data: { family: null, settings: { recognitionGlossary: [] }, childAvatarText: "", stageName: "", birthdayText: "", inviteCodeText: "", roleName: "", expandedSection: "", loading: true, loadFailed: false, isCreator: false, canEditSettings: false, advanceDay: true, advanceHours: false, targetFather: true, targetMother: true, targetChild: false, reminderStatus: null, reminderStatusText: "", reminderStatusDetail: "", loadingReminderStatus: false, subscribing: false, saving: false, exportingData: false, leavingFamily: false, guestMode: false },
  async onShow() {
    let session;
    try {
      session = await requireFamily({ redirect: false });
    } catch (error) {
      console.error("Load settings session failed", getErrorContext(error));
      this.enterGuestMode();
      showError(error, "身份校验失败，请稍后重试");
      return;
    }
    if (!session) { this.enterGuestMode(); return; }
    this.setData({ guestMode: false });
    await this.load();
  },
  enterGuestMode() {
    this.setData({ family: null, settings: { recognitionGlossary: [] }, reminderStatus: null, isCreator: false, canEditSettings: false, guestMode: true, loading: false, loadFailed: false, expandedSection: "" });
  },
  async load() {
    this.setData({ loading: true, loadFailed: false });
    try {
      const settingsRequest = callFunction("settings", "get");
      const reminderStatusRequest = callFunction("reminder", "getStatus").catch((error) => {
        console.error("Reminder status request failed", getErrorContext(error));
        return createUnavailableReminderStatus();
      });
      const [data, reminderStatus] = await Promise.all([
        settingsRequest,
        reminderStatusRequest,
      ]);
      const settings = {
        ...data.settings,
        recognitionGlossary: Array.isArray(data.settings && data.settings.recognitionGlossary)
          ? data.settings.recognitionGlossary
          : [],
      };
      const isCreator = data.currentRole === "creator";
      const reminderPresentation = getReminderStatusPresentation(reminderStatus);
      const childAvatarText = Array.from(data.family.childNickname || data.family.childName || "孩")[0];
      this.setData({ roleName: isCreator ? "家庭管理员" : data.currentRole === "child" ? "孩子账号" : "家庭成员" });
      this.setData({ family: data.family, settings, childAvatarText, reminderStatus, reminderStatusText: reminderPresentation.text, reminderStatusDetail: reminderPresentation.detail, stageName: (EDUCATION_STAGES.find((item) => item.value === data.family.educationStage) || {}).label || data.family.educationStage, birthdayText: formatDate(data.family.childBirthday), inviteCodeText: formatInviteCode(data.family.inviteCode || ""), isCreator, canEditSettings: isCreator || (data.currentRole === "member" && settings.allowMemberEditSettings), advanceDay: settings.reminderDefaultAdvance.includes(1440), advanceHours: settings.reminderDefaultAdvance.includes(120), targetFather: settings.reminderTargets.includes("father"), targetMother: settings.reminderTargets.includes("mother"), targetChild: settings.reminderTargets.includes("child"), guestMode: false });
    } catch (error) { this.setData({ loadFailed: true }); showError(error, "设置加载失败"); }
    finally { this.setData({ loading: false }); }
  },
  requestSettingsAccess() {
    wx.showModal({ title: "使用家庭设置", content: "登录并加入家庭后，可管理真实资料和服务设置。", confirmText: "去登录", cancelText: "继续体验", success(result) { if (result.confirm) wx.navigateTo({ url: "/pages/login/login" }); } });
  },
  goMembers() { if (this.data.guestMode) { this.requestSettingsAccess(); return; } wx.navigateTo({ url: "/pages/family-members/family-members" }); },
  goSubjects() { if (this.data.guestMode) { this.requestSettingsAccess(); return; } wx.navigateTo({ url: "/pages/subject-settings/subject-settings" }); },
  goTimetable() { wx.navigateTo({ url: "/pages/timetable/timetable" }); },
  goPlans() { getApp().globalData.growthEntry = { view: "plan" }; wx.switchTab({ url: "/pages/habit-list/habit-list" }); },
  toggleSection(event) {
    if (this.data.saving || this.data.subscribing || this.data.exportingData || this.data.leavingFamily) return;
    const section = event.currentTarget.dataset.section;
    if (!["reminder", "ai", "general", "data", "privacy"].includes(section)) return;
    if (this.data.guestMode && section !== "privacy") { this.requestSettingsAccess(); return; }
    const expandedSection = this.data.expandedSection === section ? "" : section;
    this.setData({ expandedSection }, () => {
      if (typeof wx.pageScrollTo === "function") wx.pageScrollTo({ selector: expandedSection ? ".settings-panel" : ".settings-group", duration: 200 });
    });
  },
  openPrivacyContract() {
    if (typeof wx.openPrivacyContract !== "function") { wx.showToast({ title: "请通过右上角菜单查看隐私保护指引", icon: "none" }); return; }
    wx.openPrivacyContract({ fail(error) {
      console.error("Open privacy contract failed", getErrorContext(error));
      showError(createDisplayError(getErrorContext(error)), "暂时无法打开隐私保护指引，请稍后重试");
    } });
  },
  exportFamilyData() {
    if (!this.data.isCreator || this.data.exportingData) return;
    wx.showModal({
      title: "导出家庭数据",
      content: "将生成包含家庭共享记录的数据文件。文件只保存在当前设备，请妥善保管，不要转发给无关人员。",
      confirmText: "生成文件",
      success: async (result) => {
        if (!result.confirm || this.data.exportingData) return;
        this.setData({ exportingData: true });
        try {
          const exported = { exportVersion: 1, generatedAt: "", family: null, datasets: {}, truncatedDatasets: [] };
          for (const dataset of EXPORT_DATASETS) {
            let offset = 0;
            let hasMore = true;
            const items = [];
            while (hasMore) {
              const page = await callFunction("settings", "exportDataPage", { dataset, offset });
              if (page.dataset !== dataset || !Array.isArray(page.items) || !Number.isSafeInteger(page.nextOffset)
                || page.nextOffset < offset || page.nextOffset > 5000) throw new Error("导出数据格式不正确");
              items.push(...page.items);
              if (!exported.family && page.family) exported.family = page.family;
              if (!exported.generatedAt && page.generatedAt) exported.generatedAt = page.generatedAt;
              if (page.truncated === true && !exported.truncatedDatasets.includes(dataset)) exported.truncatedDatasets.push(dataset);
              hasMore = page.hasMore === true;
              if (hasMore && page.nextOffset === offset) throw new Error("导出分页未推进");
              offset = page.nextOffset;
            }
            exported.datasets[dataset] = items;
          }
          const content = JSON.stringify(exported, null, 2);
          const fileSystem = typeof wx.getFileSystemManager === "function" ? wx.getFileSystemManager() : null;
          const userDataPath = wx.env && wx.env.USER_DATA_PATH;
          if (!fileSystem || !userDataPath) {
            wx.setClipboardData({ data: content, success() { wx.showToast({ title: "数据已复制", icon: "success" }); } });
            return;
          }
          const fileName = `成长搭档家庭数据-${new Date().toISOString().slice(0, 10)}.json`;
          const filePath = `${userDataPath}/${fileName}`;
          await new Promise((resolve, reject) => fileSystem.writeFile({ filePath, data: content, encoding: "utf8", success: resolve, fail: reject }));
          if (typeof wx.shareFileMessage === "function") {
            wx.shareFileMessage({ filePath, fileName, fail(error) { showError(error, "数据文件已生成，但暂时无法分享"); } });
          } else {
            wx.setClipboardData({ data: content, success() { wx.showToast({ title: "数据已复制", icon: "success" }); } });
          }
        } catch (error) { showError(error, "家庭数据导出失败"); }
        finally { this.setData({ exportingData: false }); }
      },
    });
  },
  leaveFamily() {
    if (this.data.isCreator || this.data.leavingFamily) return;
    wx.showModal({
      title: "退出当前家庭",
      content: "退出后将立即无法查看这个家庭的作业、通知、课程表、习惯和计划；共享数据不会被删除。请输入“退出家庭”确认。",
      editable: true,
      placeholderText: "输入：退出家庭",
      confirmText: "确认退出",
      success: async (result) => {
        if (!result.confirm) return;
        if ((result.content || "").trim() !== "退出家庭") { wx.showToast({ title: "确认文字不正确", icon: "none" }); return; }
        this.setData({ leavingFamily: true });
        try {
          await callFunction("family", "leaveFamily");
          const app = getApp();
          app.globalData.user = null;
          app.globalData.family = null;
          wx.reLaunch({ url: "/pages/login/login?step=family" });
        } catch (error) { showError(error, "退出家庭失败"); }
        finally { this.setData({ leavingFamily: false }); }
      },
    });
  },
  copyInviteCode() {
    if (!this.data.family.inviteCode) return;
    wx.setClipboardData({ data: this.data.family.inviteCode });
  },
  editFamily() {
    const fields = [
      { key: "childName", label: "孩子姓名", value: this.data.family.childName || "", required: true },
      { key: "childNickname", label: "孩子昵称", value: this.data.family.childNickname || "", required: false },
      { key: "className", label: "班级名称", value: this.data.family.className || "", required: false },
    ];
    wx.showActionSheet({
      itemList: fields.map((item) => item.label),
      success: (actionResult) => {
        const field = fields[actionResult.tapIndex];
        wx.showModal({
          title: `修改${field.label}`,
          editable: true,
          content: field.value,
          placeholderText: field.label,
          success: async (modalResult) => {
            const value = (modalResult.content || "").trim();
            if (!modalResult.confirm || (field.required && !value)) return;
            try { await callFunction("settings", "updateFamily", { [field.key]: value }); await this.load(); }
            catch (error) { showError(error); }
          },
        });
      },
    });
  },
  changeSemester(event) { if (!this.data.isCreator) return; const semester = getAdjacentSemester(this.data.family.currentSemester, Number(event.currentTarget.dataset.offset)); wx.showModal({ title: "切换当前学期", content: `切换到${semester}后，各业务页默认显示该学期数据，历史数据不会删除。`, success: async (result) => { if (!result.confirm) return; try { await callFunction("settings", "changeSemester", { semester }); await this.load(); } catch (error) { showError(error); } } }); },
  onAdvanceChange(event) {
    const advance = Number(event.detail.value);
    if (![1440, 120].includes(advance)) {
      wx.showToast({ title: "提醒时间无效，请重新选择", icon: "none" });
      return;
    }
    this.setData({ "settings.reminderDefaultAdvance": [advance], advanceDay: advance === 1440, advanceHours: advance === 120 });
  },
  onTargetsChange(event) { const values = event.detail.value; this.setData({ "settings.reminderTargets": values, targetFather: values.includes("father"), targetMother: values.includes("mother"), targetChild: values.includes("child") }); },
  onMemberEditChange(event) { this.setData({ "settings.allowMemberEditSettings": event.detail.value }); },
  addRecognitionGlossaryEntry() {
    if (!this.data.canEditSettings || this.data.saving) return;
    const entries = Array.isArray(this.data.settings.recognitionGlossary) ? this.data.settings.recognitionGlossary.slice() : [];
    if (entries.length >= 30) { wx.showToast({ title: "最多添加30条家庭常用词", icon: "none" }); return; }
    entries.push({ term: "", hint: "" });
    this.setData({ "settings.recognitionGlossary": entries });
  },
  onRecognitionGlossaryInput(event) {
    if (!this.data.canEditSettings || this.data.saving) return;
    const index = Number(event.currentTarget.dataset.index);
    const field = event.currentTarget.dataset.field;
    const entries = Array.isArray(this.data.settings.recognitionGlossary) ? this.data.settings.recognitionGlossary.map((item) => ({ ...item })) : [];
    if (!Number.isInteger(index) || index < 0 || index >= entries.length || !["term", "hint"].includes(field)) return;
    entries[index][field] = event.detail.value;
    this.setData({ "settings.recognitionGlossary": entries });
  },
  removeRecognitionGlossaryEntry(event) {
    if (!this.data.canEditSettings || this.data.saving) return;
    const index = Number(event.currentTarget.dataset.index);
    const entries = Array.isArray(this.data.settings.recognitionGlossary) ? this.data.settings.recognitionGlossary.slice() : [];
    if (!Number.isInteger(index) || index < 0 || index >= entries.length) return;
    entries.splice(index, 1);
    this.setData({ "settings.recognitionGlossary": entries });
  },
  async retryReminderStatus() {
    if (this.data.loadingReminderStatus) return;
    this.setData({ loadingReminderStatus: true });
    try { await this.load(); } finally { this.setData({ loadingReminderStatus: false }); }
  },
  async addReminderSubscription() {
    if (this.data.subscribing) return;
    try {
      const reminderStatus = this.data.reminderStatus;
      if (!reminderStatus || !reminderStatus.enabled) {
        wx.showToast({ title: this.data.reminderStatusDetail || "提醒功能暂不可用，请重新查询状态", icon: "none" });
        return;
      }
      if (!reminderStatus || typeof reminderStatus.templateId !== "string" || !reminderStatus.templateId) {
        throw new Error("提醒模板不可用，请刷新页面后重试");
      }
      this.setData({ subscribing: true });
      const subscription = await requestReminderSubscription(reminderStatus.templateId);
      if (subscription.decision === "accept") {
        await callFunction("reminder", "recordSubscription", subscription);
        wx.showToast({ title: "已增加 1 次提醒", icon: "success" });
        await this.load();
        return;
      }
      if (subscription.decision === "reject") {
        wx.showToast({ title: "你已拒绝本次提醒授权，可在需要时再次开启", icon: "none" });
        return;
      }
      if (subscription.decision === "ban") {
        wx.showToast({ title: "微信已限制此类订阅，请稍后在微信设置中调整", icon: "none" });
        return;
      }
      if (subscription.decision === "filter") {
        wx.showToast({ title: "消息被微信过滤，请检查订阅消息设置", icon: "none" });
      }
    } catch (error) {
      const errorContext = getErrorContext(error);
      console.error("Reminder subscription failed", errorContext);
      showError(createDisplayError(errorContext), "订阅授权失败，请稍后重试");
    } finally {
      this.setData({ subscribing: false });
    }
  },
  async save() {
    if (this.data.saving) return;
    const recognitionGlossary = Array.isArray(this.data.settings.recognitionGlossary) ? this.data.settings.recognitionGlossary : [];
    if (recognitionGlossary.some((item) => !item || typeof item.term !== "string" || !item.term.trim())) {
      wx.showToast({ title: "请填写常用词，或删除空白词条", icon: "none" });
      return;
    }
    this.setData({ saving: true });
    try { const settings = await callFunction("settings", "updatePreferences", this.data.settings); this.setData({ settings }); wx.showToast({ title: "设置已保存", icon: "success" }); }
    catch (error) { showError(error); }
    finally { this.setData({ saving: false }); }
  },
});
