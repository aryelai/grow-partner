const { validateIsoDate } = require("./validation");

const ATTENTION_STATES = new Set(["needs_help", "needs_check", "needs_correction"]);

function shiftDate(value, offset) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function getWeekRange(value) {
  if (!validateIsoDate(value)) throw new TypeError("日期格式不正确");
  const date = new Date(`${value}T00:00:00.000Z`);
  const weekday = date.getUTCDay() || 7;
  const start = shiftDate(value, 1 - weekday);
  return { start, end: shiftDate(start, 6) };
}

function getPercent(done, total) {
  return total > 0 ? Math.round(done * 100 / total) : 0;
}

function formatRangeLabel(start, end) {
  const format = (value) => `${Number(value.slice(5, 7))}月${Number(value.slice(8, 10))}日`;
  return `${format(start)}—${format(end)}`;
}

function createWeeklyReview(input = {}) {
  const today = input.today;
  const range = getWeekRange(today);
  const homeworkItems = (Array.isArray(input.homework) ? input.homework : []).filter((item) => item
    && validateIsoDate(item.homeworkDate)
    && item.homeworkDate >= range.start
    && item.homeworkDate <= range.end);
  const homeworkDone = homeworkItems.filter((item) => item.isCompleted === true).length;
  const homeworkOverdue = homeworkItems.filter((item) => item.isCompleted !== true && item.homeworkDate < today).length;
  const homeworkAttention = homeworkItems.filter((item) => item.isCompleted !== true && ATTENTION_STATES.has(item.learningState)).length;

  const requirements = (Array.isArray(input.notices) ? input.notices : [])
    .flatMap((item) => item && Array.isArray(item.requirements) ? item.requirements : [])
    .filter((item) => item && typeof item === "object");
  const requirementsDone = requirements.filter((item) => item.isCompleted === true).length;

  const planTasks = (Array.isArray(input.plans) ? input.plans : [])
    .flatMap((item) => item && Array.isArray(item.items) ? item.items : [])
    .filter((item) => item && typeof item === "object");
  const planTasksDone = planTasks.filter((item) => item.isDone === true).length;

  const habits = (Array.isArray(input.habits) ? input.habits : []).filter((item) => item && typeof item === "object");
  const habitsDone = habits.filter((item) => item.completedToday === true).length;
  const longestStreak = habits.reduce((longest, item) => {
    const streak = Number(item.streak);
    return Number.isFinite(streak) && streak > 0 ? Math.max(longest, Math.floor(streak)) : longest;
  }, 0);

  return {
    start: range.start,
    end: range.end,
    rangeLabel: formatRangeLabel(range.start, range.end),
    homework: {
      total: homeworkItems.length,
      done: homeworkDone,
      overdue: homeworkOverdue,
      needsAttention: homeworkAttention,
      percent: getPercent(homeworkDone, homeworkItems.length),
    },
    noticeRequirements: {
      total: requirements.length,
      done: requirementsDone,
      percent: getPercent(requirementsDone, requirements.length),
    },
    planTasks: {
      total: planTasks.length,
      done: planTasksDone,
      percent: getPercent(planTasksDone, planTasks.length),
    },
    habits: {
      total: habits.length,
      doneToday: habitsDone,
      longestStreak,
      percent: getPercent(habitsDone, habits.length),
    },
    incomplete: input.incomplete === true,
  };
}

module.exports = { getWeekRange, createWeeklyReview };
