function toTimestamp(value, fallback) {
  if (!value) {
    return fallback;
  }
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? fallback : timestamp;
}

const LEARNING_STATE_OPTIONS = [
  { value: "", label: "未标记" },
  { value: "needs_help", label: "需要帮助" },
  { value: "needs_check", label: "待家长检查" },
  { value: "needs_correction", label: "待订正" },
  { value: "corrected", label: "已订正" },
];

const LEARNING_STATE_LABELS = Object.fromEntries(LEARNING_STATE_OPTIONS.map((item) => [item.value, item.label]));

function normalizeLearningState(value) {
  return Object.hasOwn(LEARNING_STATE_LABELS, value) ? value : "";
}

function decorateLearningState(item) {
  const learningState = normalizeLearningState(item && item.learningState);
  return {
    ...item,
    learningState,
    learningStateText: LEARNING_STATE_LABELS[learningState],
  };
}

function sortHomework(items, now = new Date(), subjectOrder = [], options = {}) {
  const currentTime = now.getTime();
  const groupBySubject = options.groupBySubject !== false;
  const subjectPositions = new Map((Array.isArray(subjectOrder) ? subjectOrder : [])
    .filter((subject) => typeof subject === "string" && subject && subject !== "全部")
    .map((subject, index) => [subject, index]));
  return [...items].sort((left, right) => {
    if (groupBySubject && subjectPositions.size) {
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
    const leftOverdue = Number.isFinite(leftDeadline) && leftDeadline < currentTime;
    const rightOverdue = Number.isFinite(rightDeadline) && rightDeadline < currentTime;

    if (leftOverdue !== rightOverdue) {
      return leftOverdue ? -1 : 1;
    }
    if (leftDeadline !== rightDeadline) {
      return leftDeadline - rightDeadline;
    }
    if (Boolean(left.isImportant) !== Boolean(right.isImportant)) {
      return left.isImportant ? -1 : 1;
    }
    if (!groupBySubject && subjectPositions.size) {
      const leftPosition = subjectPositions.has(left.subject) ? subjectPositions.get(left.subject) : Number.POSITIVE_INFINITY;
      const rightPosition = subjectPositions.has(right.subject) ? subjectPositions.get(right.subject) : Number.POSITIVE_INFINITY;
      if (leftPosition !== rightPosition) return leftPosition - rightPosition;
    }
    return toTimestamp(right.createdAt, 0) - toTimestamp(left.createdAt, 0);
  });
}

module.exports = {
  LEARNING_STATE_OPTIONS,
  decorateLearningState,
  normalizeLearningState,
  sortHomework,
};
