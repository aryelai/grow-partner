const {
  TODO_TEMPLATE_ID,
  createSubscriptionId,
  createDeliveryId,
  buildTemplateData,
  buildSafeTemplateData,
  classifySendError,
} = require("./core");

const VALID_DECISIONS = new Set(["accept", "reject", "ban", "filter"]);
const VALID_STATES = new Set(["developer", "trial", "formal"]);
const VALID_ROLES = new Set(["creator", "member", "child"]);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const DAILY_RECORD_LIMIT = 20;
const AVAILABLE_COUNT_LIMIT = 50;
const NOTICE_SCAN_LIMIT = 20;
const DELIVERY_SCAN_LIMIT = 50;
const LOCK_DURATION_MS = 10 * 60 * 1000;
const RETRY_DELAYS_MS = [30 * 60 * 1000, 60 * 60 * 1000, 120 * 60 * 1000];

function normalizeCount(value, maximum) {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(0, Math.floor(value))) : 0;
}

function documentMissing(error) {
  return Boolean(error && (error.code === "DOCUMENT_NOT_FOUND"
    || /document.*(?:does not exist|not found)/i.test(String(error.errMsg || error.message || ""))));
}

async function readDoc(database, collectionName, id) {
  try {
    const result = await database.collection(collectionName).doc(id).get();
    return result && result.data ? result.data : null;
  } catch (error) {
    if (documentMissing(error)) return null;
    throw error;
  }
}

function asDate(value) {
  if (value instanceof Date) return value;
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getNoticeId(notice) {
  return notice && (notice._id || notice.id) || "";
}

function getDeadline(value) {
  return asDate(value && (value.deadlineAt || value.remindTime));
}

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

function summarizeError(error) {
  return String(error && (error.errMsg || error.message) || "unknown error")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[A-Za-z0-9_-]{20,}/g, "[id]")
    .trim()
    .slice(0, 160);
}

function createReminderService({ database, sendSubscribeMessage, now = () => new Date(), miniprogramState }) {
  const command = database.command || {};
  const inCondition = (values) => (typeof command.in === "function" ? command.in(values) : values);
  const lteCondition = (value) => (typeof command.lte === "function" ? command.lte(value) : value);
  const gtCondition = (value) => (typeof command.gt === "function" ? command.gt(value) : value);

  async function getStatus(user) {
    const subscriptionId = createSubscriptionId(user.openid, TODO_TEMPLATE_ID);
    const [subscription, pending] = await Promise.all([
      readDoc(database, "message_subscriptions", subscriptionId),
      database.collection("reminder_deliveries").where({
        recipientOpenid: user.openid,
        status: inCondition(["waiting_subscription", "retry", "sending"]),
        deadlineAt: gtCondition(now()),
      }).count(),
    ]);
    const configurationEnabled = VALID_STATES.has(miniprogramState);
    const systemBlocked = subscription && subscription.blockedReason === "SYSTEM_BLOCKED";
    return {
      enabled: configurationEnabled && !systemBlocked,
      templateId: TODO_TEMPLATE_ID,
      estimatedAvailableCount: normalizeCount(subscription && subscription.estimatedAvailableCount, AVAILABLE_COUNT_LIMIT),
      pendingCount: Number.isFinite(pending && pending.total) ? pending.total : 0,
      blockedReason: !configurationEnabled ? "CONFIGURATION" : (systemBlocked ? "SYSTEM_BLOCKED" : ""),
    };
  }

  async function recordSubscription(user, input) {
    const { templateId, decision, requestId } = validateSubscriptionInput(input);
    const subscriptionId = createSubscriptionId(user.openid, templateId);
    await database.runTransaction(async (transaction) => {
      const current = await readDoc(transaction, "message_subscriptions", subscriptionId);
      const recentRequestIds = current && Array.isArray(current.recentRequestIds) ? current.recentRequestIds : [];
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
        blockedReason: current && current.blockedReason || "",
        createdAt: current && current.createdAt || recordedAt,
        updatedAt: recordedAt,
      } });
    });
    return getStatus(user);
  }

  async function materializeNotice(notice) {
    const noticeId = getNoticeId(notice);
    const version = Number.isInteger(notice && notice.reminderVersion) ? notice.reminderVersion : 1;
    if (!noticeId || !notice.familyId || notice.deleted || notice.reminderState === "disabled") return 0;
    const usersResult = await database.collection("users").where({
      familyId: notice.familyId,
      role: inCondition([...VALID_ROLES]),
    }).limit(50).get();
    let created = 0;
    for (const candidate of usersResult.data || []) {
      if (!candidate || typeof candidate._id !== "string" || !candidate._id) continue;
      created += await database.runTransaction(async (transaction) => {
        const [currentNotice, currentUser] = await Promise.all([
          readDoc(transaction, "notices", noticeId),
          readDoc(transaction, "users", candidate._id),
        ]);
        if (!currentNotice || currentNotice.deleted || !currentUser) return 0;
        const currentVersion = Number.isInteger(currentNotice.reminderVersion) ? currentNotice.reminderVersion : 1;
        const targets = Array.isArray(currentNotice.remindTargets) ? currentNotice.remindTargets : [];
        if (currentVersion !== version || currentNotice.reminderState !== "scheduled"
          || currentUser.familyId !== currentNotice.familyId || !currentUser.openid
          || !VALID_ROLES.has(currentUser.role) || !targets.includes(currentUser.relation)) return 0;
        const deadlineAt = getDeadline(currentNotice);
        if (!deadlineAt) return 0;
        const deliveryId = createDeliveryId(noticeId, version, currentUser.openid, TODO_TEMPLATE_ID);
        if (await readDoc(transaction, "reminder_deliveries", deliveryId)) return 0;
        const timestamp = now();
        await transaction.collection("reminder_deliveries").doc(deliveryId).set({ data: {
          deliveryId,
          noticeId,
          familyId: currentNotice.familyId,
          reminderVersion: version,
          recipientOpenid: currentUser.openid,
          recipientRelation: currentUser.relation,
          templateId: TODO_TEMPLATE_ID,
          scheduledAt: asDate(currentNotice.scheduledAt),
          deadlineAt,
          status: "waiting_subscription",
          attemptCount: 0,
          nextAttemptAt: timestamp,
          lockExpiresAt: null,
          lastErrorCode: null,
          lastErrorMessage: "",
          sentAt: null,
          quotaFinalized: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        } });
        return 1;
      });
    }
    await database.runTransaction(async (transaction) => {
      const currentNotice = await readDoc(transaction, "notices", noticeId);
      if (!currentNotice || currentNotice.deleted) return;
      const currentVersion = Number.isInteger(currentNotice.reminderVersion) ? currentNotice.reminderVersion : 1;
      if (currentVersion === version && currentNotice.reminderState === "scheduled") {
        await transaction.collection("notices").doc(noticeId).update({ data: { reminderState: "materialized", updatedAt: now() } });
      }
    });
    return created;
  }

  async function claimDelivery(deliveryId) {
    const candidateDelivery = await readDoc(database, "reminder_deliveries", deliveryId);
    if (!candidateDelivery) return null;
    const recipientResult = await database.collection("users").where({
      familyId: candidateDelivery.familyId,
      openid: candidateDelivery.recipientOpenid,
    }).limit(1).get();
    const recipientCandidate = recipientResult.data && recipientResult.data[0];
    const recipientId = recipientCandidate && recipientCandidate._id;
    const currentTime = now();
    return database.runTransaction(async (transaction) => {
      const delivery = await readDoc(transaction, "reminder_deliveries", deliveryId);
      if (!delivery) return null;
      const deadline = getDeadline(delivery);
      if (delivery.status === "sending") {
        if (!deadline || currentTime >= deadline) {
          await transaction.collection("reminder_deliveries").doc(deliveryId).update({ data: { status: "uncertain", updatedAt: currentTime, lockExpiresAt: null } });
          return { terminalStatus: "uncertain" };
        }
        if (delivery.lockExpiresAt && asDate(delivery.lockExpiresAt) > currentTime) return null;
        await transaction.collection("reminder_deliveries").doc(deliveryId).update({ data: { status: "uncertain", updatedAt: currentTime, lockExpiresAt: null } });
        return { terminalStatus: "uncertain" };
      }
      if (!["waiting_subscription", "retry"].includes(delivery.status)) return null;
      const notice = await readDoc(transaction, "notices", delivery.noticeId);
      if (!notice || notice.deleted || notice.familyId !== delivery.familyId
        || Number(notice.reminderVersion || 1) !== Number(delivery.reminderVersion)) {
        await transaction.collection("reminder_deliveries").doc(deliveryId).update({ data: { status: "canceled", updatedAt: currentTime, lockExpiresAt: null } });
        return { terminalStatus: "canceled" };
      }
      if (!["scheduled", "materialized"].includes(notice.reminderState)) {
        await transaction.collection("reminder_deliveries").doc(deliveryId).update({ data: { status: "canceled", updatedAt: currentTime, lockExpiresAt: null } });
        return { terminalStatus: "canceled" };
      }
      const recipient = typeof recipientId === "string" && recipientId
        ? await readDoc(transaction, "users", recipientId)
        : null;
      if (!recipient || !VALID_ROLES.has(recipient.role) || recipient.relation !== delivery.recipientRelation
        || recipient.familyId !== delivery.familyId || recipient.openid !== delivery.recipientOpenid
        || !Array.isArray(notice.remindTargets) || !notice.remindTargets.includes(recipient.relation)) {
        await transaction.collection("reminder_deliveries").doc(deliveryId).update({ data: { status: "canceled", updatedAt: currentTime, lockExpiresAt: null } });
        return { terminalStatus: "canceled" };
      }
      if (notice.reminderState === "scheduled") return null;
      if (!deadline) {
        await transaction.collection("reminder_deliveries").doc(deliveryId).update({ data: { status: "canceled", updatedAt: currentTime, lockExpiresAt: null } });
        return { terminalStatus: "canceled" };
      }
      if (currentTime >= deadline) {
        await transaction.collection("reminder_deliveries").doc(deliveryId).update({ data: { status: "expired", updatedAt: currentTime, lockExpiresAt: null } });
        return { terminalStatus: "expired" };
      }
      if (delivery.nextAttemptAt && asDate(delivery.nextAttemptAt) > currentTime) return null;
      const subscriptionId = createSubscriptionId(delivery.recipientOpenid, TODO_TEMPLATE_ID);
      const subscription = await readDoc(transaction, "message_subscriptions", subscriptionId);
      if (subscription && subscription.blockedReason === "SYSTEM_BLOCKED") {
        await transaction.collection("reminder_deliveries").doc(deliveryId).update({ data: {
          status: "failed",
          lastErrorCode: null,
          lastErrorMessage: "SYSTEM_BLOCKED",
          lockExpiresAt: null,
          quotaFinalized: true,
          updatedAt: currentTime,
        } });
        return { terminalStatus: "failed" };
      }
      const availableCount = normalizeCount(subscription && subscription.estimatedAvailableCount, AVAILABLE_COUNT_LIMIT);
      if (availableCount <= 0) return null;
      const next = {
        status: "sending",
        attemptCount: (delivery.attemptCount || 0) + 1,
        lockExpiresAt: new Date(currentTime.getTime() + LOCK_DURATION_MS),
        updatedAt: currentTime,
        quotaFinalized: false,
      };
      await transaction.collection("message_subscriptions").doc(subscriptionId).update({ data: { estimatedAvailableCount: availableCount - 1, updatedAt: currentTime } });
      await transaction.collection("reminder_deliveries").doc(deliveryId).update({ data: next });
      return { ...delivery, ...next, subscriptionId, notice };
    });
  }

  async function completeDelivery(claim, outcome) {
    const currentTime = now();
    const category = outcome && outcome.category;
    let status = outcome && outcome.ok ? "sent" : "failed";
    const data = {
      lastErrorCode: Number.isFinite(outcome && outcome.errCode) ? outcome.errCode : null,
      lastErrorMessage: outcome && outcome.ok ? "" : summarizeError(outcome && outcome.error),
      lockExpiresAt: null,
      updatedAt: currentTime,
    };
    let shouldRestore = false;
    if (!outcome || !outcome.ok) {
      if (category === "authorization_missing") {
        status = "waiting_subscription";
        data.nextAttemptAt = currentTime;
      } else if (category === "concurrent") {
        status = "retry";
        data.nextAttemptAt = new Date(currentTime.getTime() + RETRY_DELAYS_MS[0]);
        shouldRestore = true;
      } else if (category === "invalid_payload") {
        status = "failed";
        shouldRestore = true;
      } else if (category === "temporary") {
        const attempt = Number.isInteger(claim.attemptCount) ? claim.attemptCount : 1;
        const nextAttemptAt = new Date(currentTime.getTime() + (RETRY_DELAYS_MS[attempt - 1] || RETRY_DELAYS_MS[2]));
        const deadline = getDeadline(claim);
        shouldRestore = true;
        if (attempt <= RETRY_DELAYS_MS.length && deadline && nextAttemptAt < deadline) {
          status = "retry";
          data.nextAttemptAt = nextAttemptAt;
        } else {
          status = "expired";
        }
      } else if (category === "uncertain") {
        status = "uncertain";
      } else if (category === "blocked") {
        status = "failed";
      }
    }
    if (status === "sent") data.sentAt = currentTime;
    await database.runTransaction(async (transaction) => {
      const current = await readDoc(transaction, "reminder_deliveries", claim.deliveryId);
      if (!current || current.status !== "sending" || Number(current.attemptCount || 0) !== Number(claim.attemptCount || 0)) return;
      const update = { status, ...data, quotaFinalized: true };
      await transaction.collection("reminder_deliveries").doc(claim.deliveryId).update({ data: update });
      const subscriptionId = claim.subscriptionId || createSubscriptionId(claim.recipientOpenid, TODO_TEMPLATE_ID);
      const subscription = await readDoc(transaction, "message_subscriptions", subscriptionId);
      if (category === "authorization_missing") {
        if (subscription) await transaction.collection("message_subscriptions").doc(subscriptionId).update({ data: { estimatedAvailableCount: 0, updatedAt: currentTime } });
      } else if (shouldRestore && subscription && !current.quotaFinalized) {
        const count = normalizeCount(subscription.estimatedAvailableCount, AVAILABLE_COUNT_LIMIT);
        await transaction.collection("message_subscriptions").doc(subscriptionId).update({ data: { estimatedAvailableCount: Math.min(AVAILABLE_COUNT_LIMIT, count + 1), updatedAt: currentTime } });
      }
      if (category === "blocked" && subscription) {
        await transaction.collection("message_subscriptions").doc(subscriptionId).update({ data: { blockedReason: "SYSTEM_BLOCKED", updatedAt: currentTime } });
      }
    });
    return status;
  }

  async function updateNoticeSummary(noticeId, version) {
    const deliveryResult = await database.collection("reminder_deliveries")
      .where({ noticeId, reminderVersion: version }).limit(50).get();
    const deliveryIds = (deliveryResult.data || [])
      .map((delivery) => delivery.deliveryId || delivery._id)
      .filter((deliveryId) => typeof deliveryId === "string" && deliveryId);
    await database.runTransaction(async (transaction) => {
      const notice = await readDoc(transaction, "notices", noticeId);
      if (!notice || notice.reminderState !== "materialized" || Number(notice.reminderVersion || 1) !== Number(version)) return;
      const deliveries = await Promise.all(deliveryIds.map((deliveryId) => readDoc(transaction, "reminder_deliveries", deliveryId)));
      if (deliveries.length > 0 && deliveries.every((delivery) => delivery && delivery.status === "sent")) {
        await transaction.collection("notices").doc(noticeId).update({ data: { reminderState: "completed", isReminded: true, updatedAt: now() } });
      }
    });
  }

  function normalizeSendOutcome(response, error) {
    const value = error || response;
    const errCode = value && typeof value === "object" && Number.isFinite(value.errCode) ? value.errCode : null;
    if (!error && response && typeof response === "object" && errCode === 0) return { ok: true };
    if (!error && (!response || typeof response !== "object" || errCode === null)) {
      return { ok: false, category: "uncertain", error: new Error("unknown send result") };
    }
    return { ok: false, category: classifySendError(value), errCode, error: value };
  }

  async function sendDelivery(payload, notice) {
    let first;
    try {
      first = normalizeSendOutcome(await sendSubscribeMessage(payload));
    } catch (error) {
      first = normalizeSendOutcome(null, error);
    }
    if (first.errCode !== 45168) return first;

    let second;
    try {
      second = normalizeSendOutcome(await sendSubscribeMessage({ ...payload, data: buildSafeTemplateData(notice) }));
    } catch (error) {
      second = normalizeSendOutcome(null, error);
    }
    if (second.ok || second.category === "uncertain") return second;
    return { ...second, category: "safe_template_failed" };
  }

  async function run() {
    if (!VALID_STATES.has(miniprogramState)) {
      return { scannedNotices: 0, createdDeliveries: 0, processedDeliveries: 0, sent: 0, waiting: 0, failed: 0, expired: 0, blockedReason: "CONFIGURATION" };
    }
    const notices = await database.collection("notices").where({
      reminderState: "scheduled",
      scheduledAt: lteCondition(now()),
    }).orderBy("scheduledAt", "asc").limit(NOTICE_SCAN_LIMIT).get();
    let createdDeliveries = 0;
    for (const notice of notices.data || []) createdDeliveries += await materializeNotice(notice);
    const deliveryResult = await database.collection("reminder_deliveries").where({
      status: inCondition(["waiting_subscription", "retry", "sending"]),
      nextAttemptAt: lteCondition(now()),
    }).orderBy("nextAttemptAt", "asc").limit(DELIVERY_SCAN_LIMIT).get();
    const groups = new Map();
    for (const delivery of deliveryResult.data || []) {
      const recipient = delivery.recipientOpenid || "";
      if (!groups.has(recipient)) groups.set(recipient, []);
      groups.get(recipient).push(delivery);
    }
    let processedDeliveries = 0;
    let sent = 0;
    let waiting = 0;
    let failed = 0;
    let expired = 0;
    for (const deliveries of groups.values()) {
      deliveries.sort((left, right) => (asDate(left.nextAttemptAt) || new Date(0)) - (asDate(right.nextAttemptAt) || new Date(0)));
      for (const delivery of deliveries) {
        processedDeliveries += 1;
        const deliveryId = delivery.deliveryId || delivery._id;
        const claim = await claimDelivery(deliveryId);
        if (!claim) {
          waiting += 1;
          continue;
        }
        if (claim.terminalStatus) {
          if (claim.terminalStatus === "expired") expired += 1;
          else if (claim.terminalStatus === "failed") failed += 1;
          else if (claim.terminalStatus !== "canceled") waiting += 1;
          continue;
        }
        const notice = claim.notice;
        const payload = {
          touser: claim.recipientOpenid,
          templateId: TODO_TEMPLATE_ID,
          page: `pages/notice-detail/notice-detail?id=${claim.noticeId}`,
          miniprogramState,
          lang: "zh_CN",
          data: buildTemplateData(notice),
        };
        const outcome = await sendDelivery(payload, notice);
        const status = await completeDelivery(claim, outcome);
        if (status === "sent") sent += 1;
        else if (status === "failed") failed += 1;
        else if (status === "expired") expired += 1;
        else waiting += 1;
        await updateNoticeSummary(claim.noticeId, claim.reminderVersion);
      }
    }
    return { scannedNotices: (notices.data || []).length, createdDeliveries, processedDeliveries, sent, waiting, failed, expired };
  }

  return { getStatus, recordSubscription, run, materializeNotice, claimDelivery, completeDelivery };
}

module.exports = { createReminderService };
