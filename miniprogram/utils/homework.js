function toTimestamp(value, fallback) {
  if (!value) {
    return fallback;
  }
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? fallback : timestamp;
}

function sortHomework(items, now = new Date()) {
  const currentTime = now.getTime();
  return [...items].sort((left, right) => {
    if (Boolean(left.isCompleted) !== Boolean(right.isCompleted)) {
      return left.isCompleted ? 1 : -1;
    }

    const leftDeadline = left.hasDeadline
      ? toTimestamp(left.deadline, Number.POSITIVE_INFINITY)
      : Number.POSITIVE_INFINITY;
    const rightDeadline = right.hasDeadline
      ? toTimestamp(right.deadline, Number.POSITIVE_INFINITY)
      : Number.POSITIVE_INFINITY;
    const leftActive = leftDeadline >= currentTime;
    const rightActive = rightDeadline >= currentTime;

    if (leftActive !== rightActive) {
      return leftActive ? -1 : 1;
    }
    if (leftActive && leftDeadline !== rightDeadline) {
      return leftDeadline - rightDeadline;
    }
    if (Boolean(left.isImportant) !== Boolean(right.isImportant)) {
      return left.isImportant ? -1 : 1;
    }
    return toTimestamp(right.createdAt, 0) - toTimestamp(left.createdAt, 0);
  });
}

module.exports = { sortHomework };
