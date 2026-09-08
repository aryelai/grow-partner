function shiftDate(dateText, offset) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);
  if (!matched) {
    return "";
  }
  const date = new Date(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]));
  date.setDate(date.getDate() + offset);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function calculateStreak(checkIns, targetDate) {
  const completedDates = new Set(
    checkIns
      .filter((item) => item && item.status === "completed")
      .map((item) => item.date),
  );
  let cursor = targetDate;
  let streak = 0;
  while (completedDates.has(cursor)) {
    streak += 1;
    cursor = shiftDate(cursor, -1);
  }
  return streak;
}

function calculateCheckInPoints(streak, completedTarget) {
  const entries = [{ change: 1, reason: "完成每日打卡" }];
  const milestonePoints = { 7: 3, 21: 10, 30: 15 };
  if (milestonePoints[streak]) {
    entries.push({
      change: milestonePoints[streak],
      reason: `连续${streak}天打卡奖励`,
    });
  }
  if (completedTarget) {
    entries.push({ change: 50, reason: "完成一项习惯目标" });
  }
  return {
    total: entries.reduce((sum, item) => sum + item.change, 0),
    entries,
  };
}

module.exports = {
  calculateStreak,
  calculateCheckInPoints,
};
