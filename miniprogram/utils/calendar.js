const { validateIsoDate } = require("./validation");
const { shiftIsoDate } = require("./date");

function validateCalendarDate(value) {
  return validateIsoDate(value) && value >= "1900-01-01" && value <= "2100-12-31";
}

function createMonthCalendar(value, today, selected = value) {
  if (!validateCalendarDate(value)) throw new TypeError("Invalid calendar date");
  const first = `${value.slice(0, 7)}-01`;
  const date = new Date(`${first}T00:00:00.000Z`);
  const offset = (date.getUTCDay() + 6) % 7;
  const start = shiftIsoDate(first, -offset);
  return {
    month: first,
    label: `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月`,
    previousEnabled: first > "1900-01-01",
    nextEnabled: first < "2100-12-01",
    days: Array.from({ length: 42 }, (_, index) => {
      const day = shiftIsoDate(start, index);
      return { value: day, label: Number(day.slice(8)), inMonth: day.slice(0, 7) === first.slice(0, 7), selected: day === selected, today: day === today, disabled: !validateCalendarDate(day) };
    }),
  };
}

function shiftCalendarMonth(value, offset) {
  if (!validateCalendarDate(value) || ![-1, 1].includes(offset)) throw new TypeError("Invalid calendar month offset");
  const date = new Date(`${value.slice(0, 7)}-01T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  const target = date.toISOString().slice(0, 10);
  if (!validateCalendarDate(target)) throw new RangeError("Calendar month out of range");
  return target;
}

module.exports = { validateCalendarDate, createMonthCalendar, shiftCalendarMonth };
