const { callFunction, showError } = require("../../utils/api");
const { requireFamily } = require("../../utils/session");
const { EDUCATION_STAGES } = require("../../utils/constants");
const { getAdjacentSemester, formatDate } = require("../../utils/date");
const { formatInviteCode } = require("../../utils/invite-code");

const providers = [{ value: "deepseek", label: "DeepSeek" }, { value: "openai", label: "OpenAI" }, { value: "claude", label: "Claude" }, { value: "custom", label: "自定义" }];

Page({
  data: { family: null, settings: {}, stageName: "", birthdayText: "", inviteCodeText: "", isCreator: false, canEditSettings: false, providerLabels: providers.map((item) => item.label), providerIndex: 0, advanceDay: true, advanceHours: true, targetFather: true, targetMother: true, targetChild: false, saving: false },
  async onShow() { const session = await requireFamily(); if (!session) return; await this.load(); },
  async load() {
    try {
      const data = await callFunction("settings", "get");
      const settings = data.settings;
      const isCreator = data.currentRole === "creator";
      this.setData({ family: data.family, settings, stageName: (EDUCATION_STAGES.find((item) => item.value === data.family.educationStage) || {}).label || data.family.educationStage, birthdayText: formatDate(data.family.childBirthday), inviteCodeText: formatInviteCode(data.family.inviteCode || ""), isCreator, canEditSettings: isCreator || (data.currentRole === "member" && settings.allowMemberEditSettings), providerIndex: Math.max(0, providers.findIndex((item) => item.value === settings.aiProvider)), advanceDay: settings.reminderDefaultAdvance.includes(1440), advanceHours: settings.reminderDefaultAdvance.includes(120), targetFather: settings.reminderTargets.includes("father"), targetMother: settings.reminderTargets.includes("mother"), targetChild: settings.reminderTargets.includes("child") });
    } catch (error) { showError(error, "设置加载失败"); }
  },
  goMembers() { wx.navigateTo({ url: "/pages/family-members/family-members" }); },
  goSubjects() { wx.navigateTo({ url: "/pages/subject-settings/subject-settings" }); },
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
  onAdvanceChange(event) { const values = event.detail.value.map(Number); this.setData({ "settings.reminderDefaultAdvance": values, advanceDay: values.includes(1440), advanceHours: values.includes(120) }); },
  onTargetsChange(event) { const values = event.detail.value; this.setData({ "settings.reminderTargets": values, targetFather: values.includes("father"), targetMother: values.includes("mother"), targetChild: values.includes("child") }); },
  onMemberEditChange(event) { this.setData({ "settings.allowMemberEditSettings": event.detail.value }); },
  onProviderChange(event) { const index = Number(event.detail.value); this.setData({ providerIndex: index, "settings.aiProvider": providers[index].value }); },
  onSettingInput(event) { this.setData({ [`settings.${event.currentTarget.dataset.field}`]: event.detail.value }); },
  async save() { this.setData({ saving: true }); try { const settings = await callFunction("settings", "updatePreferences", this.data.settings); this.setData({ settings }); wx.showToast({ title: "设置已保存", icon: "success" }); } catch (error) { showError(error); } finally { this.setData({ saving: false }); } },
});
