const { TODO_TEMPLATE_ID, createSubscriptionId } = require("./core");

const VALID_DECISIONS = new Set(["accept", "reject", "ban", "filter"]);
const VALID_STATES = new Set(["developer", "trial", "formal"]);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const DAILY_RECORD_LIMIT = 20;
const AVAILABLE_COUNT_LIMIT = 50;

function validateSubscriptionInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.templateId !== TODO_TEMPLATE_ID) {
    throw new Error("INVALID_TEMPLATE");
  }
  if (!VALID_DECISIONS.has(input.decision)) throw new Error("INVALID_DECISION");
  if (typeof input.requestId !== "string" || !REQUEST_ID_PATTERN.test(input.requestId)) {
    throw new Error("INVALID_REQUEST_ID");
  }
  return { templateId: input.templateId, decision: input.decision, requestId: input.requestId };
}

function normalizeCount(value, maximum) {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(0, Math.floor(value))) : 0;
}

async function readSubscription(database, subscriptionId) {
  try {
    return (await database.collection("message_subscriptions").doc(subscriptionId).get()).data || null;
  } catch (error) {
    const message = String(error.errMsg || error.message || "");
    if (error.code === "DOCUMENT_NOT_FOUND" || /document.*(?:does not exist|not found)/i.test(message)) return null;
    throw error;
  }
}

function createReminderService({ database, sendSubscribeMessage, now = () => new Date(), miniprogramState }) {
  async function getStatus(user) {
    const subscriptionId = createSubscriptionId(user.openid, TODO_TEMPLATE_ID);
    const [subscription, pending] = await Promise.all([
      readSubscription(database, subscriptionId),
      database.collection("reminder_deliveries").where({
        recipientOpenid: user.openid,
        status: database.command.in(["waiting_subscription", "retry", "sending"]),
        deadlineAt: database.command.gt(now()),
      }).count(),
    ]);
    const enabled = VALID_STATES.has(miniprogramState);
    return {
      enabled,
      templateId: TODO_TEMPLATE_ID,
      estimatedAvailableCount: normalizeCount(subscription && subscription.estimatedAvailableCount, AVAILABLE_COUNT_LIMIT),
      pendingCount: pending.total,
      blockedReason: enabled ? "" : "CONFIGURATION",
    };
  }

  async function recordSubscription(user, input) {
    const { templateId, decision, requestId } = validateSubscriptionInput(input);
    const subscriptionId = createSubscriptionId(user.openid, templateId);
    await database.runTransaction(async (transaction) => {
      const current = await readSubscription(transaction, subscriptionId);
      const recentRequestIds = current && Array.isArray(current.recentRequestIds) ? current.recentRequestIds : [];
      // 去重先于日限检查，重试已成功请求不会再次占用登记额度。
      if (recentRequestIds.includes(requestId)) return;
      const recordedAt = now();
      const dailyRecordDate = new Date(recordedAt.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const dailyRecordCount = current && current.dailyRecordDate === dailyRecordDate
        ? normalizeCount(current.dailyRecordCount, DAILY_RECORD_LIMIT) : 0;
      if (dailyRecordCount >= DAILY_RECORD_LIMIT) throw new Error("DAILY_LIMIT");
      const availableCount = normalizeCount(current && current.estimatedAvailableCount, AVAILABLE_COUNT_LIMIT);
      await transaction.collection("message_subscriptions").doc(subscriptionId).set({ data: {
        openid: user.openid,
        templateId,
        estimatedAvailableCount: Math.min(AVAILABLE_COUNT_LIMIT, availableCount + (decision === "accept" ? 1 : 0)),
        lastDecision: decision,
        recentRequestIds: [...recentRequestIds, requestId].slice(-DAILY_RECORD_LIMIT),
        dailyRecordDate,
        dailyRecordCount: dailyRecordCount + 1,
        createdAt: current && current.createdAt || recordedAt,
        updatedAt: recordedAt,
      } });
    });
    return getStatus(user);
  }

  async function run() {
    // 调度与发送由后续任务实现，此处不得产生扫描、写入或发送副作用。
    return { skipped: true, reason: "SCHEDULER_NOT_IMPLEMENTED" };
  }

  return { getStatus, recordSubscription, run };
}

module.exports = { createReminderService };
