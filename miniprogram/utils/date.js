function pad(value) {
  return String(value).padStart(2, "0");
}

function toLocalDate(value) {
  if (value instanceof Date) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }

  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (!matched) {
    throw new TypeError("Invalid date value");
  }
  return new Date(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]));
}

function formatDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return `${formatDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function getCurrentSemester(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError("Invalid date value");
  }
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  if (month >= 2 && month <= 7) {
    return `${year}上`;
  }
  return `${month === 1 ? year - 1 : year}下`;
}

function getAdjacentSemester(semester, offset) {
  const matched = /^(\d{4})(上|下)$/.exec(String(semester));
  if (!matched || !Number.isInteger(offset)) {
    throw new TypeError("Invalid semester value");
  }

  const base = Number(matched[1]) * 2 + (matched[2] === "下" ? 1 : 0);
  const target = base + offset;
  return `${Math.floor(target / 2)}${target % 2 === 0 ? "上" : "下"}`;
}

function getDateRangeForPlan(type, dateValue) {
  const date = toLocalDate(dateValue);
  if (type === "daily") {
    const current = formatDate(date);
    return { start: current, end: current };
  }

  if (type === "weekly") {
    const weekday = date.getDay() || 7;
    const start = new Date(date);
    start.setDate(date.getDate() - weekday + 1);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { start: formatDate(start), end: formatDate(end) };
  }

  if (type === "monthly") {
    const start = new Date(date.getFullYear(), date.getMonth(), 1);
    const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
    return { start: formatDate(start), end: formatDate(end) };
  }

  throw new TypeError("Invalid plan type");
}

module.exports = {
  formatDate,
  formatDateTime,
  getCurrentSemester,
  getAdjacentSemester,
  getDateRangeForPlan,
};
