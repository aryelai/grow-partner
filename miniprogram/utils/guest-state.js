// 演示状态只存在本次小程序进程中，不进入缓存或真实家庭数据。
const completionState = { homework: Object.create(null), notice: Object.create(null) };

function applyGuestCompletion(kind, items) {
  const state = completionState[kind];
  return items.map((item) => state && Object.prototype.hasOwnProperty.call(state, item._id)
    ? { ...item, isCompleted: state[item._id] } : item);
}

function setGuestCompletion(kind, id, value) {
  if (!completionState[kind] || typeof id !== "string" || typeof value !== "boolean") return;
  completionState[kind][id] = value;
}

function resetGuestCompletion() {
  for (const kind of Object.keys(completionState)) completionState[kind] = Object.create(null);
}

module.exports = { applyGuestCompletion, setGuestCompletion, resetGuestCompletion };
