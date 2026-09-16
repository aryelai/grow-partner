const { callFunction, showError } = require("../../utils/api");
const { requireFamily } = require("../../utils/session");
const { validateIsoDate } = require("../../utils/validation");
const { formatDate } = require("../../utils/date");
const { createPlanController, createPlanData } = require("../../utils/plan-controller");
const controller = createPlanController({ requireFamily, callFunction, showError, wxApi: wx });

Component({
  options: { addGlobalClass: true, styleIsolation: "apply-shared" },
  properties: {
    entryDate: { type: String, value: "", observer(value) {
      if (!validateIsoDate(value)) return;
      this.setData({ type: "daily", anchorDate: value });
      if (this.panelReady) this.refresh();
    } },
  },
  data: createPlanData(),
  lifetimes: {
    attached() { this.panelReady = true; this.refresh(); },
    detached() { this.panelReady = false; this.loadVersion = (this.loadVersion || 0) + 1; },
  },
  methods: {
    refresh() { return controller.refresh.call(this); },
    enterGuestMode() { return controller.enterGuestMode.call(this); },
    async load() { await controller.load.call(this); this.notifySummary(); },
    notifySummary() {
      if (!this.panelReady || this.data.loading || this.data.loadFailed) return;
      this.triggerEvent("summarychange", { isToday: this.data.type === "daily" && this.data.anchorDate === formatDate(new Date()), total: this.data.totalTasks, done: this.data.doneTasks });
    },
    selectType(event) { return controller.selectType.call(this, event); },
    shiftDate(event) { return controller.shiftDate.call(this, event); },
    goToday() { return controller.goToday.call(this); },
    create() { return controller.create.call(this); },
    edit(event) { return controller.edit.call(this, event); },
    toggleTask(event) { return controller.toggleTask.call(this, event); },
    async toggleItem(event) { await controller.toggleItem.call(this, event); this.notifySummary(); },
  },
});
