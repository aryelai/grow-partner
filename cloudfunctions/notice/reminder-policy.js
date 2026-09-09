const VALID_ADVANCES = new Set([120, 1440]);

function normalizeAdvance(value) {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const advance = Number(value[0]);
  return Number.isInteger(advance) && VALID_ADVANCES.has(advance) ? advance : null;
}

function sameTargets(left, right) {
  return [...new Set(left)].sort().join("|") === [...new Set(right)].sort().join("|");
}

function getReminderTime(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

function hasReminderConfigChanged(current, next) {
  const currentTime = getReminderTime(current && current.remindTime);
  const nextTime = getReminderTime(next.remindTime);
  return currentTime !== nextTime
    || normalizeAdvance(current && current.remindAdvance) !== normalizeAdvance(next.remindAdvance)
    || !sameTargets(current && Array.isArray(current.remindTargets) ? current.remindTargets : [], next.remindTargets)
    || Boolean(currentTime) !== Boolean(nextTime);
}

function buildReminderFields(next, current = null) {
  const enabled = next.remindTime instanceof Date && !Number.isNaN(next.remindTime.getTime());
  const advance = normalizeAdvance(next.remindAdvance);
  if (enabled && advance === null) throw new Error("INVALID_ADVANCE");
  if (enabled && next.remindTargets.length === 0) throw new Error("MISSING_TARGETS");
  const currentVersion = Number.isInteger(current && current.reminderVersion) ? current.reminderVersion : 0;
  const changed = !current || hasReminderConfigChanged(current, next) || (enabled && currentVersion === 0);
  return {
    remindAdvance: advance === null ? [120] : [advance],
    scheduledAt: enabled ? new Date(next.remindTime.getTime() - advance * 60000) : null,
    reminderVersion: changed ? currentVersion + 1 : currentVersion,
    reminderState: enabled ? (changed ? "scheduled" : current.reminderState || "scheduled") : "disabled",
    isReminded: changed ? false : current && current.isReminded === true,
  };
}

module.exports = { normalizeAdvance, hasReminderConfigChanged, buildReminderFields };
