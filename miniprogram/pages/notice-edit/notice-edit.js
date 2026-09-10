const { callFunction, showError, uploadFile } = require("../../utils/api");
const { requireFamily } = require("../../utils/session");
const { NOTICE_CATEGORIES, RELATIONS } = require("../../utils/constants");
const { formatDate } = require("../../utils/date");
const { canPerform } = require("../../utils/permissions");
const { requestReminderSubscription, shouldRequestSubscription } = require("../../utils/subscription");

const VALID_ADVANCES = new Set([120, 1440]);
const REMINDER_RELATIONS = Object.entries(RELATIONS).map(([value, label]) => ({ value, label }));

function normalizeAdvance(value, fallback = 120) {
  const values = Array.isArray(value) ? value : [value];
  const advance = values.map(Number).find((item) => VALID_ADVANCES.has(item));
  return [advance || fallback];
}

function normalizeTargets(value) {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values.filter((item) => typeof item === "string" && RELATIONS[item]))];
}

function createReminderRelations(targets) {
  return REMINDER_RELATIONS.map((item) => ({ ...item, checked: targets.includes(item.value) }));
}

function getReminderTimestamp(value) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function createUnavailableReminderStatus() {
  return { enabled: false, templateId: "", estimatedAvailableCount: 0, pendingCount: 0, blockedReason: "STATUS_UNAVAILABLE" };
}

function reminderSettings(data) {
  return data && data.settings ? data.settings : {};
}

function getErrorContext(error) {
  const message = String((error && (error.message || error.errMsg)) || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
  const code = typeof (error && error.code) === "string" ? error.code.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48) : "";
  return { message, code };
}

function getRemindTime(reminderEnabled, dateValue, timeValue) {
  if (!reminderEnabled) return null;
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateValue));
  const timeMatched = /^(\d{2}):(\d{2})$/.exec(String(timeValue));
  if (!matched || !timeMatched) return undefined;
  const date = new Date(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]), Number(timeMatched[1]), Number(timeMatched[2]));
  if (date.getFullYear() !== Number(matched[1]) || date.getMonth() !== Number(matched[2]) - 1 || date.getDate() !== Number(matched[3]) || date.getHours() !== Number(timeMatched[1]) || date.getMinutes() !== Number(timeMatched[2])) return undefined;
  return date.toISOString();
}

Page({
  data: {
    id: "", categories: NOTICE_CATEGORIES, reminderRelations: createReminderRelations([]),
    form: { semester: "2026下", title: "", source: "", category: "other", content: "", images: [], remindAdvance: [120], remindTargets: [] },
    reminderEnabled: false, reminderStatus: createUnavailableReminderStatus(), needsSubscription: false, initializing: false, initializationFailed: false,
    remindDate: formatDate(new Date()), remindTime: "08:00", uploading: false, submitting: false,
  },
  async refreshPermission() {
    let session;
    try { session = await requireFamily(); }
    catch (error) { this.currentUser = null; this.familyId = null; showError(error, "身份校验失败，请稍后重试"); return null; }
    if (!session) { this.currentUser = null; this.familyId = null; return null; }
    this.currentUser = session.user;
    this.familyId = session.user.familyId;
    if (!canPerform(session.user.role, "manageNotice")) { wx.showToast({ title: "孩子账号不能新增或编辑通知", icon: "none" }); return null; }
    return session;
  },
  async onLoad(options) {
    this.setData({ initializing: true, initializationFailed: false });
    try {
      const session = await this.refreshPermission();
      if (!session) { this.setData({ initializationFailed: true }); if (this.currentUser) wx.navigateBack(); return; }
      const [settingsData, reminderStatus] = await Promise.all([
        callFunction("settings", "get").catch((error) => { showError(error, "家庭设置加载失败，请稍后重试"); return { settings: {} }; }),
        callFunction("reminder", "getStatus").catch((error) => {
          console.error("Reminder status request failed", getErrorContext(error));
          return createUnavailableReminderStatus();
        }),
      ]);
      const settings = reminderSettings(settingsData);
      const form = {
        ...this.data.form,
        semester: session.family.currentSemester,
        remindAdvance: normalizeAdvance(settings.reminderDefaultAdvance),
        remindTargets: normalizeTargets(settings.reminderTargets),
      };
      this.setData({ id: options.id || "", form, reminderRelations: createReminderRelations(form.remindTargets), reminderStatus, needsSubscription: this.getSubscriptionNeed({ form, reminderStatus }) });
      if (options.id && !await this.load(options.id)) { this.setData({ initializationFailed: true }); wx.navigateBack(); }
    } finally { this.setData({ initializing: false }); }
  },
  async load(id) {
    try {
      const item = await callFunction("notice", "get", { id });
      const remind = item.remindTime && !Number.isNaN(new Date(item.remindTime).getTime()) ? new Date(item.remindTime) : new Date();
      const form = {
        ...item,
        images: Array.isArray(item.images) ? item.images : [],
        remindAdvance: normalizeAdvance(item.remindAdvance),
        remindTargets: normalizeTargets(item.remindTargets),
      };
      this.originalReminder = {
        remindTime: item.remindTime || null,
        remindAdvance: normalizeAdvance(item.remindAdvance),
        remindTargets: normalizeTargets(item.remindTargets),
        reminderState: item.reminderState,
      };
      this.setData({
        form,
        reminderRelations: createReminderRelations(form.remindTargets),
        reminderEnabled: Boolean(item.remindTime),
        remindDate: formatDate(remind),
        remindTime: `${String(remind.getHours()).padStart(2, "0")}:${String(remind.getMinutes()).padStart(2, "0")}`,
        needsSubscription: this.getSubscriptionNeed({ form, reminderEnabled: Boolean(item.remindTime) }),
      });
      return true;
    } catch (error) { showError(error); return false; }
  },
  isFormLocked() { return this.data.initializing || this.data.initializationFailed; },
  getSubscriptionNeed(overrides = {}) {
    const form = overrides.form || this.data.form;
    const reminderStatus = overrides.reminderStatus || this.data.reminderStatus;
    const reminderEnabled = Object.prototype.hasOwnProperty.call(overrides, "reminderEnabled") ? overrides.reminderEnabled : this.data.reminderEnabled;
    return shouldRequestSubscription({
      reminderEnabled: reminderEnabled && reminderStatus && reminderStatus.enabled,
      currentRelation: this.currentUser && this.currentUser.relation,
      remindTargets: form.remindTargets,
      estimatedAvailableCount: reminderStatus && reminderStatus.estimatedAvailableCount,
      templateId: reminderStatus && reminderStatus.templateId,
    });
  },
  onInput(event) { if (!this.isFormLocked()) this.setData({ [`form.${event.currentTarget.dataset.field}`]: event.detail.value }); },
  selectCategory(event) { if (!this.isFormLocked()) this.setData({ "form.category": event.currentTarget.dataset.value }); },
  toggleReminder(event) {
    if (this.isFormLocked()) return;
    const reminderEnabled = event.detail.value;
    this.setData({ reminderEnabled, needsSubscription: this.getSubscriptionNeed({ reminderEnabled }) });
  },
  onRemindDate(event) { if (!this.isFormLocked()) this.setData({ remindDate: event.detail.value }); },
  onRemindTime(event) { if (!this.isFormLocked()) this.setData({ remindTime: event.detail.value }); },
  onAdvanceChange(event) {
    if (this.isFormLocked()) return;
    const form = { ...this.data.form, remindAdvance: normalizeAdvance(event.detail.value) };
    this.setData({ form, needsSubscription: this.getSubscriptionNeed({ form }) });
  },
  onTargetsChange(event) {
    if (this.isFormLocked()) return;
    const form = { ...this.data.form, remindTargets: normalizeTargets(event.detail.value) };
    this.setData({ form, reminderRelations: createReminderRelations(form.remindTargets), needsSubscription: this.getSubscriptionNeed({ form }) });
  },
  async chooseImages() {
    if (this.isFormLocked()) return;
    if (!await this.refreshPermission()) { this.setData({ uploading: false }); return; }
    try {
      const result = await wx.chooseMedia({ count: 9 - this.data.form.images.length, mediaType: ["image"], sizeType: ["compressed"] });
      const session = await this.refreshPermission();
      if (!session) return;
      if (result.tempFiles.some((item) => item.size > 10 * 1024 * 1024)) { wx.showToast({ title: "单张图片不能超过10MB", icon: "none" }); return; }
      this.setData({ uploading: true });
      const stamp = Date.now();
      const images = await Promise.all(result.tempFiles.map((item, index) => uploadFile(`notices/${session.user.familyId}/${stamp}-${index}.jpg`, item.tempFilePath)));
      this.setData({ "form.images": [...this.data.form.images, ...images] });
    } catch (error) { if (!String(error.errMsg || error.message).includes("cancel")) showError(error); }
    finally { this.setData({ uploading: false }); }
  },
  removeImage(event) { if (this.isFormLocked()) return; const images = [...this.data.form.images]; images.splice(event.currentTarget.dataset.index, 1); this.setData({ "form.images": images }); },
  hasMaterializedReminderChanged(remindTime) {
    if (!this.data.id || !this.originalReminder || !["materialized", "completed"].includes(this.originalReminder.reminderState)) return false;
    return getReminderTimestamp(this.originalReminder.remindTime) !== getReminderTimestamp(remindTime)
      || this.originalReminder.remindAdvance[0] !== this.data.form.remindAdvance[0]
      || [...this.originalReminder.remindTargets].sort().join("|") !== [...this.data.form.remindTargets].sort().join("|");
  },
  save() {
    if (this.saveInProgress || this.isFormLocked()) return;
    if (!this.data.form.title.trim()) { wx.showToast({ title: "请填写通知标题", icon: "none" }); return; }
    if (this.data.reminderEnabled && this.data.form.remindTargets.length === 0) { wx.showToast({ title: "请至少选择一个提醒对象", icon: "none" }); return; }
    const remindTime = getRemindTime(this.data.reminderEnabled, this.data.remindDate, this.data.remindTime);
    if (remindTime === undefined) { wx.showToast({ title: "提醒时间格式不正确", icon: "none" }); return; }
    this.saveInProgress = true;
    this.setData({ submitting: true });
    try {
      if (this.hasMaterializedReminderChanged(remindTime)) {
        wx.showModal({
          title: "创建新的提醒版本",
          content: "修改已完成调度的提醒时间、提前量、提醒对象或启停状态会创建新提醒版本，并可能再次通知。确认继续吗？",
          success: (result) => {
            if (result.confirm) this.persist(remindTime);
            else this.releaseSaveLock();
          },
          fail: () => this.releaseSaveLock(),
        });
        return;
      }
      return this.persist(remindTime);
    } catch (error) { this.releaseSaveLock(); showError(error, "通知保存失败"); }
  },
  releaseSaveLock() { this.saveInProgress = false; this.setData({ submitting: false }); },
  async persist(remindTime) {
    const shouldSubscribe = this.getSubscriptionNeed();
    const subscriptionRequest = shouldSubscribe ? requestReminderSubscription(this.data.reminderStatus.templateId) : null;
    let subscriptionDenied = false;
    let recordFailed = false;
    try {
      if (!await this.refreshPermission()) return;
      if (subscriptionRequest) {
        try {
          const subscription = await subscriptionRequest;
          if (subscription.decision === "accept") {
            try { await callFunction("reminder", "recordSubscription", subscription); }
            catch (error) { console.error("Reminder subscription record failed", { message: error && error.message }); recordFailed = true; }
          } else subscriptionDenied = true;
        } catch (error) { subscriptionDenied = true; }
      }
      await callFunction("notice", this.data.id ? "update" : "create", { ...this.data.form, id: this.data.id, remindTime });
      if (recordFailed) wx.showToast({ title: "通知已保存，微信提醒授权记录失败，请到设置页重试", icon: "none" });
      else if (subscriptionDenied) wx.showToast({ title: "通知已保存，微信提醒未授权", icon: "none" });
      wx.navigateBack();
    }
    catch (error) { showError(error, "通知保存失败"); }
    finally { this.releaseSaveLock(); }
  },
  async remove() { if (!await this.refreshPermission()) return; wx.showModal({ title: "删除通知", content: "删除后无法恢复，确认继续吗？", success: async (result) => { if (!result.confirm) return; if (!await this.refreshPermission()) return; try { await callFunction("notice", "remove", { id: this.data.id }); wx.navigateBack(); } catch (error) { showError(error); } } }); },
});
