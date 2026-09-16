const { callFunction, showError } = require("../../utils/api");
const { requireFamily } = require("../../utils/session");
const { NOTICE_CATEGORIES, RELATIONS } = require("../../utils/constants");
const { formatDate, formatDateTime } = require("../../utils/date");
const { canPerform } = require("../../utils/permissions");
const { requestReminderSubscription, shouldRequestSubscription } = require("../../utils/subscription");
const { createShareAppMessage, createShareTimelineMessage } = require("../../utils/share");

const VALID_ADVANCES = new Set([120, 1440]);
const REMINDER_RELATIONS = Object.entries(RELATIONS).map(([value, label]) => ({ value, label }));
const SENSITIVE_ERROR_VALUE_PATTERN = /((?:^|[{\s,?&;])(?:["'])?(?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|client[_-]?secret|password|cookie|openid|secret|key)(?:["'])?\s*[:=]\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,;}&]+)/gi;

function hasRelation(value) {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(RELATIONS, value);
}

function normalizeAdvance(value, fallback = 120) {
  const values = Array.isArray(value) ? value : [value];
  const advance = values.map(Number).find((item) => VALID_ADVANCES.has(item));
  return [advance || fallback];
}

function normalizeTargets(value) {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values.filter(hasRelation))];
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

function redactSensitiveValues(message) {
  return message
    .replace(SENSITIVE_ERROR_VALUE_PATTERN, "$1[REDACTED]")
    .replace(/\bo[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]");
}

function getErrorContext(error) {
  const normalizedMessage = String((error && (error.message || error.errMsg)) || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const message = redactSensitiveValues(normalizedMessage).slice(0, 160);
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

function createFormSnapshot(form) {
  return Object.freeze({
    ...form,
    images: Object.freeze([...(Array.isArray(form.images) ? form.images : [])]),
    remindAdvance: Object.freeze([...(Array.isArray(form.remindAdvance) ? form.remindAdvance : [])]),
    remindTargets: Object.freeze([...(Array.isArray(form.remindTargets) ? form.remindTargets : [])]),
  });
}

Page({
  onShareAppMessage: createShareAppMessage,
  onShareTimeline: createShareTimelineMessage,

  data: {
    id: "", categories: NOTICE_CATEGORIES, reminderRelations: createReminderRelations([]),
    form: { semester: "2026下", title: "", source: "", category: "other", content: "", images: [], remindAdvance: [120], remindTargets: [] },
    reminderEnabled: false, reminderStatus: createUnavailableReminderStatus(), needsSubscription: false, initializing: false, initializationFailed: false,
    remindDate: formatDate(new Date()), remindTime: "08:00", submitting: false,
    eventEnabled: false, eventDate: formatDate(new Date()), eventClock: "08:00",
    deadlineEnabled: false, deadlineDate: formatDate(new Date()), deadlineClock: "18:00",
    aiDraftRequestId: "", aiSuggestedRemindTime: "", aiSuggestedRemindTimeText: "",
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
    this.bindAiDraftChannel(options);
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
      this.aiDraftReady = true;
      if (this.pendingAiDraft) this.applyAiDraft(this.pendingAiDraft, session.family.currentSemester);
      if (options.id && !await this.load(options.id)) { this.setData({ initializationFailed: true }); wx.navigateBack(); }
    } finally { this.setData({ initializing: false }); }
  },
  bindAiDraftChannel(options = {}) {
    if (options.source !== "ai" || typeof this.getOpenerEventChannel !== "function") return;
    const eventChannel = this.getOpenerEventChannel();
    if (!eventChannel || typeof eventChannel.on !== "function") return;
    eventChannel.on("noticeDraft", (draft) => {
      this.pendingAiDraft = draft;
      if (this.aiDraftReady && this.data.form) this.applyAiDraft(draft, this.data.form.semester);
    });
  },
  applyAiDraft(draft, currentSemester) {
    if (!draft || typeof draft !== "object" || Array.isArray(draft)) return;
    const requestId = typeof draft.requestId === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(draft.requestId)
      ? draft.requestId : "";
    const title = typeof draft.title === "string" ? draft.title.trim().slice(0, 80) : "";
    if (!requestId || !title) return;
    const category = NOTICE_CATEGORIES.some((item) => item.value === draft.category) ? draft.category : "other";
    const suggestion = new Date(draft.suggestedRemindTime || "");
    const suggestedRemindTime = Number.isNaN(suggestion.getTime()) ? "" : suggestion.toISOString();
    const form = {
      ...this.data.form,
      semester: /^\d{4}(上|下)$/.test(String(currentSemester)) ? currentSemester : this.data.form.semester,
      title,
      source: typeof draft.source === "string" ? draft.source.trim().slice(0, 60) : "",
      category,
      content: typeof draft.content === "string" ? draft.content.trim().slice(0, 3000) : "",
    };
    this.setData({
      form,
      aiDraftRequestId: requestId,
      aiSuggestedRemindTime: suggestedRemindTime,
      aiSuggestedRemindTimeText: suggestedRemindTime ? formatDateTime(suggestedRemindTime) : "",
      reminderEnabled: false,
      needsSubscription: this.getSubscriptionNeed({ form, reminderEnabled: false }),
    });
  },
  useAiSuggestion() {
    if (this.isFormLocked() || !this.data.aiSuggestedRemindTime) return;
    const suggestion = new Date(this.data.aiSuggestedRemindTime);
    if (Number.isNaN(suggestion.getTime())) return;
    const pad = (value) => String(value).padStart(2, "0");
    const remindDate = `${suggestion.getFullYear()}-${pad(suggestion.getMonth() + 1)}-${pad(suggestion.getDate())}`;
    const remindTime = `${pad(suggestion.getHours())}:${pad(suggestion.getMinutes())}`;
    this.setData({
      reminderEnabled: true,
      remindDate,
      remindTime,
      aiSuggestedRemindTime: "",
      needsSubscription: this.getSubscriptionNeed({ reminderEnabled: true }),
    });
  },
  async load(id) {
    try {
      const item = await callFunction("notice", "get", { id });
      const reminderTimestamp = getReminderTimestamp(item.remindTime);
      const reminderEnabled = reminderTimestamp !== null;
      const remind = reminderEnabled ? new Date(reminderTimestamp) : new Date();
      const form = {
        ...item,
        images: Array.isArray(item.images) ? item.images : [],
        remindAdvance: normalizeAdvance(item.remindAdvance),
        remindTargets: normalizeTargets(item.remindTargets),
      };
      this.originalReminder = {
        remindTime: reminderEnabled ? item.remindTime : null,
        remindAdvance: normalizeAdvance(item.remindAdvance),
        remindTargets: normalizeTargets(item.remindTargets),
        reminderState: item.reminderState,
      };
      this.setData({
        form,
        ...this.getTimeFields("event", item.eventTime, "08:00"),
        ...this.getTimeFields("deadline", item.deadline, "18:00"),
        reminderRelations: createReminderRelations(form.remindTargets),
        reminderEnabled,
        remindDate: formatDate(remind),
        remindTime: `${String(remind.getHours()).padStart(2, "0")}:${String(remind.getMinutes()).padStart(2, "0")}`,
        needsSubscription: this.getSubscriptionNeed({ form, reminderEnabled }),
      });
      return true;
    } catch (error) { showError(error); return false; }
  },
  isFormLocked() { return this.data.initializing || this.data.initializationFailed || this.data.submitting; },
  getTimeFields(prefix, value, fallbackClock) {
    const timestamp = (value instanceof Date || typeof value === "string") && value ? getReminderTimestamp(value) : null;
    const date = timestamp !== null ? new Date(timestamp) : new Date();
    return {
      [`${prefix}Enabled`]: timestamp !== null,
      [`${prefix}Date`]: formatDate(date),
      [`${prefix}Clock`]: timestamp !== null ? `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}` : fallbackClock,
    };
  },
  toggleEvent(event) { if (!this.isFormLocked()) this.setData({ eventEnabled: event.detail.value }); },
  toggleDeadline(event) { if (!this.isFormLocked()) this.setData({ deadlineEnabled: event.detail.value }); },
  onEventDate(event) { if (!this.isFormLocked()) this.setData({ eventDate: event.detail.value }); },
  onEventClock(event) { if (!this.isFormLocked()) this.setData({ eventClock: event.detail.value }); },
  onDeadlineDate(event) { if (!this.isFormLocked()) this.setData({ deadlineDate: event.detail.value }); },
  onDeadlineClock(event) { if (!this.isFormLocked()) this.setData({ deadlineClock: event.detail.value }); },
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
  removeImage(event) { if (this.isFormLocked()) return; const images = [...this.data.form.images]; images.splice(event.currentTarget.dataset.index, 1); this.setData({ "form.images": images }); },
  hasMaterializedReminderChanged(remindTime, form, id) {
    if (!id || !this.originalReminder || !["materialized", "completed"].includes(this.originalReminder.reminderState)) return false;
    return getReminderTimestamp(this.originalReminder.remindTime) !== getReminderTimestamp(remindTime)
      || this.originalReminder.remindAdvance[0] !== form.remindAdvance[0]
      || [...this.originalReminder.remindTargets].sort().join("|") !== [...form.remindTargets].sort().join("|");
  },
  save() {
    if (this.saveInProgress || this.isFormLocked()) return;
    const eventTime = getRemindTime(this.data.eventEnabled, this.data.eventDate, this.data.eventClock);
    const deadline = getRemindTime(this.data.deadlineEnabled, this.data.deadlineDate, this.data.deadlineClock);
    if (eventTime === undefined || deadline === undefined) { wx.showToast({ title: "事项或截止时间格式不正确", icon: "none" }); return; }
    const form = createFormSnapshot({ ...this.data.form, eventTime, deadline });
    const reminderEnabled = this.data.reminderEnabled;
    const reminderStatus = Object.freeze({ ...this.data.reminderStatus });
    if (!form.title.trim()) { wx.showToast({ title: "请填写通知标题", icon: "none" }); return; }
    if (reminderEnabled && form.remindTargets.length === 0) { wx.showToast({ title: "请至少选择一个提醒对象", icon: "none" }); return; }
    const remindTime = getRemindTime(reminderEnabled, this.data.remindDate, this.data.remindTime);
    if (remindTime === undefined) { wx.showToast({ title: "提醒时间格式不正确", icon: "none" }); return; }
    const snapshot = Object.freeze({
      id: this.data.id,
      form,
      remindTime,
      clientRequestId: this.data.id ? "" : this.data.aiDraftRequestId,
      reminderStatus,
      shouldSubscribe: this.getSubscriptionNeed({ form, reminderStatus, reminderEnabled }),
    });
    this.saveInProgress = true;
    this.setData({ submitting: true });
    try {
      if (this.hasMaterializedReminderChanged(remindTime, form, snapshot.id)) {
        wx.showModal({
          title: "创建新的提醒版本",
          content: "修改已完成调度的提醒时间、提前量、提醒对象或启停状态会创建新提醒版本，并可能再次通知。确认继续吗？",
          success: (result) => {
            if (result.confirm) this.persist(snapshot);
            else this.releaseSaveLock();
          },
          fail: () => this.releaseSaveLock(),
        });
        return;
      }
      return this.persist(snapshot);
    } catch (error) { this.releaseSaveLock(); showError(error, "通知保存失败"); }
  },
  releaseSaveLock() { this.saveInProgress = false; this.setData({ submitting: false }); },
  async persist(snapshot) {
    const subscriptionRequest = snapshot.shouldSubscribe ? requestReminderSubscription(snapshot.reminderStatus.templateId) : null;
    let subscriptionDenied = false;
    let recordFailed = false;
    try {
      if (!await this.refreshPermission()) return;
      if (subscriptionRequest) {
        try {
          const subscription = await subscriptionRequest;
          if (subscription.decision === "accept") {
            try { await callFunction("reminder", "recordSubscription", subscription); }
            catch (error) { console.error("Reminder subscription record failed", getErrorContext(error)); recordFailed = true; }
          } else subscriptionDenied = true;
        } catch (error) { console.error("Reminder subscription request failed", getErrorContext(error)); subscriptionDenied = true; }
      }
      await callFunction("notice", snapshot.id ? "update" : "create", {
        ...snapshot.form,
        id: snapshot.id,
        remindTime: snapshot.remindTime,
        ...(snapshot.clientRequestId ? { clientRequestId: snapshot.clientRequestId } : {}),
      });
      if (recordFailed) wx.showToast({ title: "通知已保存，微信提醒授权记录失败，请到设置页重试", icon: "none" });
      else if (subscriptionDenied) wx.showToast({ title: "通知已保存，微信提醒未授权", icon: "none" });
      if (this.data.aiDraftRequestId && typeof this.getOpenerEventChannel === "function") {
        const eventChannel = this.getOpenerEventChannel();
        if (eventChannel && typeof eventChannel.emit === "function") {
          eventChannel.emit("noticeSaved", { requestId: this.data.aiDraftRequestId });
        }
      }
      wx.navigateBack();
    }
    catch (error) { showError(error, "通知保存失败"); }
    finally { this.releaseSaveLock(); }
  },
  async remove() { if (this.isFormLocked() || !await this.refreshPermission()) return; wx.showModal({ title: "删除通知", content: "删除后无法恢复，确认继续吗？", success: async (result) => { if (!result.confirm) return; if (!await this.refreshPermission()) return; try { await callFunction("notice", "remove", { id: this.data.id }); wx.navigateBack(); } catch (error) { showError(error); } } }); },
});
