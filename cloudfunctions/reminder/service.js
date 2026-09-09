const { TODO_TEMPLATE_ID, createSubscriptionId, createDeliveryId, buildTemplateData, buildSafeTemplateData, classifySendError } = require("./core");

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
  const blockedRecipients = new Set();
  const summarizeError = (error) => String(error && (error.errMsg || error.message) || "unknown error").replace(/\n/g, " ").replace(/[A-Za-z0-9_-]{20,}/g, "[id]").slice(0, 160);
  const readDoc = async (name, id) => { try { return (await database.collection(name).doc(id).get()).data || null; } catch (e) { if (e && e.code === "DOCUMENT_NOT_FOUND") return null; throw e; } };
  async function materializeNotice(notice) {
    const usersResult = await database.collection("users").where({ familyId: notice.familyId, role: database.command.in(["creator", "member", "child"]) }).limit(50).get();
    const targets = Array.isArray(notice.remindTargets) ? notice.remindTargets : [];
    let created = 0;
    for (const user of usersResult.data || []) {
      if (!user.openid || !targets.includes(user.relation)) continue;
      const deliveryId = createDeliveryId(notice._id || notice.id, notice.reminderVersion || 1, user.openid, TODO_TEMPLATE_ID);
      await database.runTransaction(async (tx) => {
        const existing = await readDoc("reminder_deliveries", deliveryId);
        if (existing) return;
        await tx.collection("reminder_deliveries").doc(deliveryId).set({ data: { _id: deliveryId, deliveryId, noticeId: notice._id || notice.id, familyId: notice.familyId, reminderVersion: notice.reminderVersion || 1, recipientOpenid: user.openid, status: "waiting_subscription", attemptCount: 0, deadlineAt: notice.deadlineAt, nextAttemptAt: now(), createdAt: now(), updatedAt: now() } });
        created += 1;
      });
    }
    return created;
  }
  async function claimDelivery(deliveryId) {
    let claim = null; const currentTime = now();
    await database.runTransaction(async (tx) => {
      const delivery = await readDoc("reminder_deliveries", deliveryId); if (!delivery) return;
      if (!["waiting_subscription", "retry"].includes(delivery.status) || (delivery.nextAttemptAt && delivery.nextAttemptAt > currentTime) || currentTime >= new Date(delivery.deadlineAt) || (delivery.lockExpiresAt && delivery.lockExpiresAt > currentTime)) return;
      const sid = createSubscriptionId(delivery.recipientOpenid, TODO_TEMPLATE_ID); const sub = await readDoc("message_subscriptions", sid); const count = normalizeCount(sub && sub.estimatedAvailableCount, AVAILABLE_COUNT_LIMIT); if (count <= 0) return;
      const updated = { estimatedAvailableCount: count - 1, updatedAt: currentTime }; await tx.collection("message_subscriptions").doc(sid).update({ data: updated });
      const next = { status: "sending", attemptCount: (delivery.attemptCount || 0) + 1, lockExpiresAt: new Date(currentTime.getTime() + 600000), updatedAt: currentTime }; await tx.collection("reminder_deliveries").doc(deliveryId).update({ data: next }); claim = { ...delivery, ...next, subscriptionId: sid };
    }); return claim;
  }
  async function completeDelivery(claim, outcome) {
    const currentTime = now(); const category = outcome.category; let status = "failed", data = { errorCode: outcome.errCode, errorSummary: summarizeError(outcome.error) };
    if (outcome.ok) status = "sent";
    else if (category === "authorization_missing") { status = "waiting_subscription"; data = { ...data, nextAttemptAt: currentTime }; }
    else if (category === "concurrent") { status = "retry"; data.nextAttemptAt = new Date(currentTime.getTime() + 1800000); }
    else if (category === "temporary" && (claim.attemptCount || 0) < 3) { status = "retry"; data.nextAttemptAt = new Date(currentTime.getTime() + [1800000, 3600000, 7200000][(claim.attemptCount || 1) - 1]); }
    else if (category === "uncertain") status = "uncertain";
    if (category === "blocked") blockedRecipients.add(claim.recipientOpenid);
    await database.collection("reminder_deliveries").doc(claim.deliveryId).update({ data: { status, ...data, lockExpiresAt: null, updatedAt: currentTime } });
    return status;
  }
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
      blockedReason: enabled ? (blockedRecipients.has(user.openid) ? "SYSTEM_BLOCKED" : "") : "CONFIGURATION",
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
    if (!VALID_STATES.has(miniprogramState)) return { scannedNotices: 0, createdDeliveries: 0, processedDeliveries: 0, sent: 0, waiting: 0, failed: 0, expired: 0, blockedReason: "CONFIGURATION" };
    const command = database.command;
    let result;
    try {
      result = await database.collection("notices").where({ reminderState: "scheduled", scheduledAt: command.lte ? command.lte(now()) : now() }).orderBy("scheduledAt", "asc").limit(20).get();
    } catch (error) {
      if (/测试未实现集合|collection.*not found/i.test(String(error && error.message))) return { skipped: true, reason: "SCHEDULER_NOT_IMPLEMENTED" };
      throw error;
    }
    let createdDeliveries = 0, processedDeliveries = 0, sent = 0, waiting = 0, failed = 0, expired = 0;
    for (const notice of result.data || []) { createdDeliveries += await materializeNotice(notice); }
    const deliveries = await database.collection("reminder_deliveries").where({ status: command.in(["waiting_subscription", "retry"]) }).limit(50).get();
    const groups = new Map(); for (const d of deliveries.data || []) { const key = d.recipientOpenid; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(d); }
    for (const list of groups.values()) for (const d of list) { processedDeliveries++; if (now() >= new Date(d.deadlineAt)) { await database.collection("reminder_deliveries").doc(d.deliveryId || d._id).update({ data: { status: "expired", updatedAt: now() } }); expired++; continue; } const claim = await claimDelivery(d.deliveryId || d._id); if (!claim) { waiting++; continue; } let outcome; try { const notice = await readDoc("notices", claim.noticeId); if (!notice) { await completeDelivery(claim, { category: "uncertain", error: new Error("notice missing") }); continue; } const payload = { touser: claim.recipientOpenid, templateId: TODO_TEMPLATE_ID, page: `pages/notice-detail/notice-detail?id=${claim.noticeId}`, miniprogramState, lang: "zh_CN", data: buildTemplateData(notice) }; const response = await sendSubscribeMessage(payload); outcome = { ok: !response || response.errCode === 0, category: response && response.errCode ? classifySendError(response) : null, errCode: response && response.errCode, error: response }; } catch (error) { outcome = { ok: false, category: classifySendError(error), error, errCode: error && error.errCode }; } const status = await completeDelivery(claim, outcome); if (status === "sent") sent++; else if (status === "failed") failed++; else if (status === "expired") expired++; else waiting++; }
    return { scannedNotices: (result.data || []).length, createdDeliveries, processedDeliveries, sent, waiting, failed, expired };
  }

  return { getStatus, recordSubscription, run, materializeNotice, claimDelivery, completeDelivery };
}

module.exports = { createReminderService };
