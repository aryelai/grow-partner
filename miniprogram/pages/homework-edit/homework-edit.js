const { callFunction, showError } = require("../../utils/api");
const { requireFamily } = require("../../utils/session");
const { DEFAULT_SUBJECTS, CURRENT_SEMESTER } = require("../../utils/constants");
const { formatDate, getBeijingDate, formatHomeworkDate } = require("../../utils/date");
const { validateUrl, validateIsoDate } = require("../../utils/validation");
const { canPerform } = require("../../utils/permissions");
const { createShareAppMessage, createShareTimelineMessage } = require("../../utils/share");

Page({
  onShareAppMessage: createShareAppMessage,
  onShareTimeline: createShareTimelineMessage,

  data: {
    id: "",
    form: { semester: CURRENT_SEMESTER, subject: "", homeworkDate: "", title: "", content: "", images: [], videos: [], links: [], extraRequirement: "", isImportant: false, hasDeadline: false, extraTags: [] },
    homeworkDateText: "请选择作业日期",
    subjects: [],
    deadlineDate: formatDate(new Date()),
    deadlineTime: "20:00",
    linkInput: "",
    tagInput: "",
    submitting: false,
  },

  async refreshPermission(action = this.data.id ? "updateHomework" : "createHomework") {
    let session;
    try { session = await requireFamily(); }
    catch (error) { this.currentUser = null; this.familyId = null; showError(error, "身份校验失败，请稍后重试"); return null; }
    if (!session) { this.currentUser = null; this.familyId = null; return null; }
    this.currentUser = session.user;
    this.familyId = session.user.familyId;
    if (!canPerform(session.user.role, action)) { wx.showToast({ title: "孩子账号不能新增或编辑作业", icon: "none" }); return null; }
    return session;
  },

  async onLoad(options) {
    const action = options.id ? "updateHomework" : "createHomework";
    const session = await this.refreshPermission(action);
    if (!session) { if (this.currentUser) wx.navigateBack(); return; }
    let subjects = DEFAULT_SUBJECTS[session.family.educationStage] || DEFAULT_SUBJECTS.junior_high;
    try {
      const subjectData = await callFunction("settings", "getSubjects");
      subjects = subjectData.subjects;
    } catch (error) {
      console.error("Load custom subjects failed", { message: error.message });
    }
    const homeworkDate = options.id ? "" : (validateIsoDate(options.homeworkDate) ? options.homeworkDate : getBeijingDate());
    this.setData({
      id: options.id || "",
      subjects,
      "form.semester": options.semester || session.family.currentSemester,
      "form.subject": subjects[0],
      "form.homeworkDate": homeworkDate,
      homeworkDateText: homeworkDate ? formatHomeworkDate(homeworkDate) : "请选择作业日期",
    });
    if (options.id) await this.loadDetail(options.id);
  },

  async loadDetail(id) {
    try {
      const item = await callFunction("homework", "get", { id });
      const deadline = item.deadline ? new Date(item.deadline) : new Date();
      this.setData({
        form: { ...item, homeworkDate: validateIsoDate(item.homeworkDate) ? item.homeworkDate : "", images: item.images || [], videos: item.videos || [], links: item.links || [], extraTags: item.extraTags || [] },
        homeworkDateText: validateIsoDate(item.homeworkDate) ? formatHomeworkDate(item.homeworkDate) : "请选择作业日期",
        deadlineDate: formatDate(deadline),
        deadlineTime: `${String(deadline.getHours()).padStart(2, "0")}:${String(deadline.getMinutes()).padStart(2, "0")}`,
      });
    } catch (error) { showError(error); }
  },

  onInput(event) { this.setData({ [`form.${event.currentTarget.dataset.field}`]: event.detail.value }); },
  onSwitch(event) { this.setData({ [`form.${event.currentTarget.dataset.field}`]: event.detail.value }); },
  selectSubject(event) { this.setData({ "form.subject": event.currentTarget.dataset.value }); },
  onHomeworkDate(event) {
    this.setData({ "form.homeworkDate": event.detail.value, homeworkDateText: formatHomeworkDate(event.detail.value) });
  },
  onDeadlineDate(event) { this.setData({ deadlineDate: event.detail.value }); },
  onDeadlineTime(event) { this.setData({ deadlineTime: event.detail.value }); },
  onLinkInput(event) { this.setData({ linkInput: event.detail.value }); },
  onTagInput(event) { this.setData({ tagInput: event.detail.value }); },

  addLink() {
    const value = this.data.linkInput.trim();
    if (!validateUrl(value)) { wx.showToast({ title: "请输入正确的 http/https 链接", icon: "none" }); return; }
    if (this.data.form.links.length >= 5) { wx.showToast({ title: "最多添加5个链接", icon: "none" }); return; }
    this.setData({ "form.links": [...this.data.form.links, value], linkInput: "" });
  },
  removeLink(event) { const links = [...this.data.form.links]; links.splice(event.currentTarget.dataset.index, 1); this.setData({ "form.links": links }); },
  addTag() {
    const value = this.data.tagInput.trim();
    if (!value || this.data.form.extraTags.includes(value)) return;
    if (this.data.form.extraTags.length >= 10) { wx.showToast({ title: "最多添加10个标签", icon: "none" }); return; }
    this.setData({ "form.extraTags": [...this.data.form.extraTags, value], tagInput: "" });
  },
  removeTag(event) { const tags = [...this.data.form.extraTags]; tags.splice(event.currentTarget.dataset.index, 1); this.setData({ "form.extraTags": tags }); },

  removeMedia(event) { const type = event.currentTarget.dataset.type; const values = [...this.data.form[type]]; values.splice(event.currentTarget.dataset.index, 1); this.setData({ [`form.${type}`]: values }); },

  async save() {
    if (this.saveInProgress) return;
    this.saveInProgress = true;
    this.setData({ submitting: true });
    try {
      if (!await this.refreshPermission()) return;
      const form = this.data.form;
      if (!form.subject || !form.title.trim()) { wx.showToast({ title: "请选择科目并填写主题", icon: "none" }); return; }
      if (!validateIsoDate(form.homeworkDate)) { wx.showToast({ title: "请选择正确的作业日期", icon: "none" }); return; }
      if (form.title.trim().length > 500) { wx.showToast({ title: "主题不能超过500字", icon: "none" }); return; }
      const deadline = form.hasDeadline ? new Date(`${this.data.deadlineDate}T${this.data.deadlineTime}:00`).toISOString() : null;
      await callFunction("homework", this.data.id ? "update" : "create", { ...form, id: this.data.id, deadline });
      wx.navigateBack();
    } catch (error) { showError(error, "作业保存失败"); }
    finally { this.saveInProgress = false; this.setData({ submitting: false }); }
  },
});
