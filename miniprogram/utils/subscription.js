const VALID_DECISIONS = new Set(["accept", "reject", "ban", "filter"]);
const { RELATIONS } = require("./constants");
const TEMPLATE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function createRequestId(now, randomValue) {
  const timestamp = Number.isFinite(now) && now >= 0 ? Math.floor(now) : Date.now();
  const random = Number.isFinite(randomValue) && randomValue >= 0 && randomValue < 1 ? randomValue : Math.random();
  const entropy = Math.floor(random * Number.MAX_SAFE_INTEGER).toString(36).padStart(10, "0");

  return `subscription_${timestamp.toString(36)}_${entropy}`;
}

function getDecision(result, templateId) {
  const decision = result && result[templateId];
  if (!VALID_DECISIONS.has(decision)) throw new Error("Invalid subscription decision");
  return decision;
}

function shouldRequestSubscription({ reminderEnabled, currentRelation, remindTargets, estimatedAvailableCount, templateId }) {
  return reminderEnabled === true
    && typeof currentRelation === "string"
    && Boolean(RELATIONS[currentRelation])
    && Array.isArray(remindTargets)
    && remindTargets.includes(currentRelation)
    && typeof estimatedAvailableCount === "number"
    && Number.isFinite(estimatedAvailableCount)
    && estimatedAvailableCount >= 0
    && estimatedAvailableCount <= 50
    && estimatedAvailableCount === 0
    && typeof templateId === "string"
    && TEMPLATE_ID_PATTERN.test(templateId);
}

async function requestReminderSubscription(templateId) {
  if (typeof templateId !== "string" || !templateId) throw new Error("Invalid subscription template ID");
  const requestId = createRequestId(Date.now(), Math.random());
  const result = await wx.requestSubscribeMessage({ tmplIds: [templateId] });

  return { templateId, decision: getDecision(result, templateId), requestId };
}

module.exports = { createRequestId, getDecision, shouldRequestSubscription, requestReminderSubscription };
