const { callFunction, showError, uploadFile } = require("../../utils/api");
const { requireFamily } = require("../../utils/session");
const { DEFAULT_SUBJECTS, CURRENT_SEMESTER } = require("../../utils/constants");
const { formatDate } = require("../../utils/date");
const { validateUrl } = require("../../utils/validation");

function fileExtension(path) {
  const matched = /\.([a-z0-9]+)(?:\?|$)/i.exec(path);
  return matched ? matched[1].toLowerCase() : "dat";
}

Page({
  data: {
    id: "",
    form: { semester: CURRENT_SEMESTER, subject: "", title: "", content: "", images: [], videos: [], links: [], extraRequirement: "", isImportant: false, hasDeadline: false, extraTags: [] },
    subjects: [],
    deadlineDate: formatDate(new Date()),
    deadlineTime: "20:00",
    linkInput: "",
    tagInput: "",
    uploading: false,
    submitting: false,
  },

  async onLoad(options) {
    const session = await requireFamily();
    if (!session) return;
    this.familyId = session.user.familyId;
    let subjects = DEFAULT_SUBJECTS[session.family.educationStage] || DEFAULT_SUBJECTS.junior_high;
    try {
      const subjectData = await callFunction("settings", "getSubjects");
      subjects = subjectData.subjects;
    } catch (error) {
      console.error("Load custom subjects failed", { message: error.message });
    }
    this.setData({
      id: options.id || "",
      subjects,
      "form.semester": options.semester || session.family.currentSemester,
      "form.subject": subjects[0],
    });
    if (options.id) await this.loadDetail(options.id);
  },

  async loadDetail(id) {
    try {
      const item = await callFunction("homework", "get", { id });
      const deadline = item.deadline ? new Date(item.deadline) : new Date();
      this.setData({
        form: { ...item, images: item.images || [], videos: item.videos || [], links: item.links || [], extraTags: item.extraTags || [] },
        deadlineDate: formatDate(deadline),
        deadlineTime: `${String(deadline.getHours()).padStart(2, "0")}:${String(deadline.getMinutes()).padStart(2, "0")}`,
      });
    } catch (error) { showError(error); }
  },

  onInput(event) { this.setData({ [`form.${event.currentTarget.dataset.field}`]: event.detail.value }); },
  onSwitch(event) { this.setData({ [`form.${event.currentTarget.dataset.field}`]: event.detail.value }); },
  selectSubject(event) { this.setData({ "form.subject": event.currentTarget.dataset.value }); },
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

  async chooseMedia() {
    try {
      const remainingImages = 9 - this.data.form.images.length;
      const result = await wx.chooseMedia({ count: Math.min(9, remainingImages + (this.data.form.videos.length ? 0 : 1)), mediaType: ["image", "video"], sizeType: ["compressed"] });
      const imageFiles = result.tempFiles.filter((item) => item.fileType === "image").slice(0, remainingImages);
      const videoFiles = this.data.form.videos.length ? [] : result.tempFiles.filter((item) => item.fileType === "video").slice(0, 1);
      if (imageFiles.some((item) => item.size > 10 * 1024 * 1024) || videoFiles.some((item) => item.size > 100 * 1024 * 1024)) {
        wx.showToast({ title: "图片需小于10MB，视频需小于100MB", icon: "none" }); return;
      }
      this.setData({ uploading: true });
      const timestamp = Date.now();
      const images = await Promise.all(imageFiles.map((item, index) => uploadFile(`homework/${this.familyId}/${timestamp}-image-${index}.${fileExtension(item.tempFilePath)}`, item.tempFilePath)));
      const videos = await Promise.all(videoFiles.map((item, index) => uploadFile(`homework/${this.familyId}/${timestamp}-video-${index}.${fileExtension(item.tempFilePath)}`, item.tempFilePath)));
      this.setData({ "form.images": [...this.data.form.images, ...images], "form.videos": [...this.data.form.videos, ...videos] });
    } catch (error) {
      if (!String(error.errMsg || error.message).includes("cancel")) showError(error, "附件上传失败");
    } finally { this.setData({ uploading: false }); }
  },
  removeMedia(event) { const type = event.currentTarget.dataset.type; const values = [...this.data.form[type]]; values.splice(event.currentTarget.dataset.index, 1); this.setData({ [`form.${type}`]: values }); },

  async save() {
    const form = this.data.form;
    if (!form.subject || !form.title.trim()) { wx.showToast({ title: "请选择科目并填写主题", icon: "none" }); return; }
    const deadline = form.hasDeadline ? new Date(`${this.data.deadlineDate}T${this.data.deadlineTime}:00`).toISOString() : null;
    this.setData({ submitting: true });
    try {
      await callFunction("homework", this.data.id ? "update" : "create", { ...form, id: this.data.id, deadline });
      wx.navigateBack();
    } catch (error) { showError(error, "作业保存失败"); }
    finally { this.setData({ submitting: false }); }
  },
});
