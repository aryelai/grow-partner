const { callFunction, showError } = require("../../utils/api");
const { formatDateTime } = require("../../utils/date");

Page({
  data: { members: [], requests: [], isCreator: false },

  onShow() { this.load(); },

  async load() {
    try {
      const data = await callFunction("family", "members");
      this.setData({ members: data.members.map((item) => ({ ...item, avatarText: (item.relationName || "家").charAt(0) })), isCreator: data.currentRole === "creator" });
      if (data.currentRole === "creator") {
        const requests = await callFunction("family", "listRequests");
        this.setData({ requests: requests.map((item) => ({ ...item, createdAtText: formatDateTime(item.createdAt) })) });
      }
    } catch (error) {
      showError(error, "家庭成员加载失败");
    }
  },

  review(event) {
    const { id, approved } = event.currentTarget.dataset;
    wx.showModal({
      title: approved ? "批准申请" : "拒绝申请",
      content: `确认${approved ? "批准" : "拒绝"}这条加入申请吗？`,
      success: async (result) => {
        if (!result.confirm) return;
        try {
          await callFunction("family", "reviewJoin", { requestId: id, approved });
          await this.load();
        } catch (error) { showError(error); }
      },
    });
  },

  removeMember(event) {
    const userId = event.currentTarget.dataset.id;
    wx.showModal({
      title: "移除成员",
      content: "移除后该成员将无法查看家庭数据，确认继续吗？",
      success: async (result) => {
        if (!result.confirm) return;
        try {
          await callFunction("family", "removeMember", { userId });
          await this.load();
        } catch (error) { showError(error); }
      },
    });
  },
});
