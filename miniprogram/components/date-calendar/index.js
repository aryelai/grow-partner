const { getBeijingDate } = require("../../utils/date");
const { validateCalendarDate, createMonthCalendar, shiftCalendarMonth } = require("../../utils/calendar");

Component({
  properties: { visible: { type: Boolean, value: false }, value: { type: String, value: "" } },
  data: { weekdays: ["一", "二", "三", "四", "五", "六", "日"], days: [], month: "", label: "", previousEnabled: true, nextEnabled: true },
  observers: {
    "visible, value"(visible, value) {
      if (visible) this.refresh(validateCalendarDate(value) ? value : getBeijingDate());
    },
  },
  methods: {
    refresh(month) { this.setData(createMonthCalendar(month, getBeijingDate(), this.data.value)); },
    changeMonth(event) {
      const offset = Number(event.currentTarget.dataset.offset);
      if (![-1, 1].includes(offset) || (offset === -1 && !this.data.previousEnabled) || (offset === 1 && !this.data.nextEnabled)) return;
      this.refresh(shiftCalendarMonth(this.data.month, offset));
    },
    selectDate(event) {
      const value = event.currentTarget.dataset.value;
      if (validateCalendarDate(value)) this.triggerEvent("change", { value });
    },
    selectToday() { this.triggerEvent("change", { value: getBeijingDate() }); },
    close() { this.triggerEvent("close"); },
    stopPropagation() {},
  },
});
