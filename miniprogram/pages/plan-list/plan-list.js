const { callFunction, showError } = require("../../utils/api");
const { requireFamily } = require("../../utils/session");
const { createPlanController, createPlanData } = require("../../utils/plan-controller");
const { createShareAppMessage, createShareTimelineMessage } = require("../../utils/share");

const controller = createPlanController({
  requireFamily: () => requireFamily({ redirect: false }),
  callFunction, showError, wxApi: wx,
});

Page({
  onShareAppMessage: createShareAppMessage,
  onShareTimeline: createShareTimelineMessage,
  data: { ...createPlanData(), guestMode: false },
  onShow() { return this.refresh(); },
  refresh() { return controller.refresh.call(this); },
  enterGuestMode() { return controller.enterGuestMode.call(this); },
  load() { return controller.load.call(this); },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  selectType(event) { return controller.selectType.call(this, event); },
  shiftDate(event) { return controller.shiftDate.call(this, event); },
  goToday() { return controller.goToday.call(this); },
  create() { return controller.create.call(this); },
  edit(event) { return controller.edit.call(this, event); },
  toggleItem(event) { return controller.toggleItem.call(this, event); },
  toggleTask(event) { return controller.toggleTask.call(this, event); },
  onUnload() { this.loadVersion = (this.loadVersion || 0) + 1; },
});
