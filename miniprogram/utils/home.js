const { normalizeTimetableEntries } = require("./timetable");

const WEEKDAY_LABELS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function pad(value) {
  return String(value).padStart(2, "0");
}

function createHomeDateContext(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("Invalid home date");
  const shanghai = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const year = shanghai.getUTCFullYear();
  const month = shanghai.getUTCMonth() + 1;
  const day = shanghai.getUTCDate();
  const weekdayIndex = shanghai.getUTCDay();
  const hour = shanghai.getUTCHours();
  const greeting = hour < 11 ? "早上好" : hour < 13 ? "中午好" : hour < 18 ? "下午好" : "晚上好";
  return {
    date: `${year}-${pad(month)}-${pad(day)}`,
    dateLabel: `${month}月${day}日`,
    weekday: weekdayIndex === 0 ? 7 : weekdayIndex,
    weekdayLabel: WEEKDAY_LABELS[weekdayIndex],
    clockMinutes: hour * 60 + shanghai.getUTCMinutes(),
    greeting,
  };
}

function toMinutes(value) {
  if (!TIME_PATTERN.test(String(value || ""))) return null;
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function createScheduleOverview(value, now = new Date()) {
  const dateContext = createHomeDateContext(now);
  const entries = normalizeTimetableEntries(value).filter((entry) => entry.dayOfWeek === dateContext.weekday);
  if (!entries.length) {
    return { hasEntries: false, total: 0, sessions: [], focus: null, following: [], stateText: "今日暂无课程" };
  }

  let focusIndex = entries.findIndex((entry) => {
    const start = toMinutes(entry.startTime);
    const end = toMinutes(entry.endTime);
    return start !== null && end !== null && dateContext.clockMinutes >= start && dateContext.clockMinutes < end;
  });
  let stateText = "";
  if (focusIndex >= 0) {
    stateText = "正在上课";
  } else {
    focusIndex = entries.findIndex((entry) => {
      const start = toMinutes(entry.startTime);
      return start !== null && start > dateContext.clockMinutes;
    });
    if (focusIndex >= 0) stateText = `${entries[focusIndex].startTime} 开始`;
  }

  if (focusIndex < 0) {
    const hasAnyTime = entries.some((entry) => toMinutes(entry.startTime) !== null);
    focusIndex = hasAnyTime ? entries.length - 1 : 0;
    stateText = hasAnyTime ? "今日课程已结束" : `今日第 ${entries[focusIndex].period} 节`;
  }

  const focus = entries[focusIndex];
  const sessions = [{ key: "morning", label: "上午", items: [] }, { key: "afternoon", label: "下午", items: [] }];
  for (const entry of entries) {
    const start = toMinutes(entry.startTime);
    // 有时间按实际时段分组；缺时间按常见上午四节降级，不截断全天课程。
    const sessionIndex = start === null ? (entry.period <= 4 ? 0 : 1) : (start < 12 * 60 ? 0 : 1);
    sessions[sessionIndex].items.push({
      ...entry,
      timeText: entry.startTime ? `${entry.startTime}–${entry.endTime}` : "时间待补充",
      isCurrent: stateText === "正在上课" && entry.period === focus.period,
    });
  }
  return {
    hasEntries: true,
    total: entries.length,
    sessions,
    focus: {
      ...focus,
      timeText: focus.startTime ? `${focus.startTime}–${focus.endTime}` : "时间待补充",
      metaText: [focus.teacher, focus.location].filter(Boolean).join(" · "),
    },
    following: entries.slice(focusIndex + 1, focusIndex + 4).map((entry) => ({
      ...entry,
      timeText: entry.startTime || `第 ${entry.period} 节`,
    })),
    stateText,
  };
}

function createPlanOverview(value) {
  const plans = Array.isArray(value) ? value : [];
  const items = plans.flatMap((plan) => Array.isArray(plan && plan.items) ? plan.items : []);
  const done = items.filter((item) => item && item.isDone === true).length;
  const pending = items.find((item) => item && item.isDone !== true && typeof item.text === "string" && item.text.trim());
  return {
    total: items.length,
    done,
    percentage: items.length ? Math.round(done * 100 / items.length) : 0,
    pendingText: pending ? pending.text.trim() : "",
  };
}

function createHabitOverview(value) {
  const habits = Array.isArray(value) ? value : [];
  const items = habits.slice(0, 4).map((habit) => ({
    ...habit,
    completedToday: Number(habit && habit.streak) > 0,
  }));
  return {
    total: habits.length,
    done: habits.filter((habit) => Number(habit && habit.streak) > 0).length,
    items,
  };
}

module.exports = {
  createHomeDateContext,
  createScheduleOverview,
  createPlanOverview,
  createHabitOverview,
};
