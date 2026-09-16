function toTimestamp(value, fallback) {
  if (!value) {
    return fallback;
  }
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? fallback : timestamp;
}

function sortHomework(items, now = new Date(), subjectOrder = []) {
  const currentTime = now.getTime();
  const subjectPositions = new Map((Array.isArray(subjectOrder) ? subjectOrder : [])
    .filter((subject) => typeof subject === "string" && subject && subject !== "全部")
    .map((subject, index) => [subject, index]));
  return [...items].sort((left, right) => {
    if (subjectPositions.size) {
      const leftPosition = subjectPositions.has(left.subject) ? subjectPositions.get(left.subject) : Number.POSITIVE_INFINITY;
      const rightPosition = subjectPositions.has(right.subject) ? subjectPositions.get(right.subject) : Number.POSITIVE_INFINITY;
      if (leftPosition !== rightPosition) return leftPosition - rightPosition;
    }
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
