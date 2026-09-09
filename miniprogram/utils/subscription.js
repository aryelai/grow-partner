const VALID_DECISIONS = new Set(["accept", "reject", "ban", "filter"]);

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

async function requestReminderSubscription(templateId) {
  if (typeof templateId !== "string" || !templateId) throw new Error("Invalid subscription template ID");
  const requestId = createRequestId(Date.now(), Math.random());
  const result = await wx.requestSubscribeMessage({ tmplIds: [templateId] });

  return { templateId, decision: getDecision(result, templateId), requestId };
}

module.exports = { createRequestId, getDecision, requestReminderSubscription };
