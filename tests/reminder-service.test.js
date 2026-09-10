const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createReminderService } = require("../cloudfunctions/reminder/service");
const { TODO_TEMPLATE_ID, createSubscriptionId, createDeliveryId } = require("../cloudfunctions/reminder/core");

const testUser = { openid: "openid-1", familyId: "family-1", role: "creator" };
const subscriptionId = createSubscriptionId(testUser.openid, TODO_TEMPLATE_ID);
const createInput = (number = 1, decision = "accept") => ({
  templateId: TODO_TEMPLATE_ID,
  decision,
  requestId: `request_20260908_${String(number).padStart(4, "0")}`,
});

function createFixture(options = {}) {
  let currentTime = new Date("2026-09-08T15:59:59.000Z");
  let records = new Map(options.subscription ? [[subscriptionId, options.subscription]] : []);
  let transactionQueue = Promise.resolve();
  let accessCount = 0;
  let writeCount = 0;
  const database = {
    command: {
      in: (values) => ({ operator: "in", values }),
      gt: (value) => ({ operator: "gt", value }),
    },
    collection(name) { return collection(name, records, false); },
    async runTransaction(callback) {
      const result = transactionQueue.then(async () => {
        const staged = structuredClone(records);
        const value = await callback({ collection: (name) => collection(name, staged, true) });
        records = staged;
        return value;
      });
      transactionQueue = result.catch(() => {});
      return result;
    },
  };
  function collection(name, storage, inTransaction) {
    accessCount += 1;
    if (options.databaseError) throw options.databaseError;
    if (name === "users") {
      return { where: (query) => ({ limit: () => ({ get: async () => ({
        data: query.openid === testUser.openid ? [testUser] : [],
      }) }) }) };
    }
    if (name === "message_subscriptions") {
      return { doc: (id) => ({
        async get() {
          if (options.subscriptionReadError) throw options.subscriptionReadError;
          if (!storage.has(id)) {
            const error = new Error("document.get:fail document does not exist");
            error.code = "DOCUMENT_NOT_FOUND";
            throw error;
          }
          return { data: structuredClone(storage.get(id)) };
        },
        async set({ data }) {
          assert.equal(inTransaction, true, "授权登记必须在事务中写入");
          storage.set(id, structuredClone(data));
          writeCount += 1;
        },
      }) };
    }
    if (name === "reminder_deliveries") {
      return { where: (query) => ({ count: async () => ({
        total: (options.deliveries || []).filter((record) => Object.entries(query).every(([key, condition]) => {
          if (condition && condition.operator === "in") return condition.values.includes(record[key]);
          if (condition && condition.operator === "gt") return record[key] > condition.value;
          return record[key] === condition;
        })).length,
      }) }) };
    }
    throw new Error(`测试未实现集合：${name}`);
  }
  const dependencies = {
    database,
    now: () => currentTime,
    miniprogramState: options.miniprogramState === undefined ? "developer" : options.miniprogramState,
    sendSubscribeMessage: async () => { throw new Error("授权登记不应发送消息"); },
  };
  return {
    dependencies,
    service: createReminderService(dependencies),
    getSubscription: () => records.get(subscriptionId),
    getRecords: () => records,
    getAccessCount: () => accessCount,
    getWriteCount: () => writeCount,
    setTime: (value) => { currentTime = new Date(value); },
  };
}

function loadReminderFunction(options = {}) {
  const fixture = createFixture(options);
  const sourcePath = path.join(__dirname, "../cloudfunctions/reminder/index.js");
  const moduleValue = { exports: {} };
  const logs = [];
  const context = vm.createContext({
    console: { error: (...args) => logs.push(args), info: (...args) => logs.push(args) },
    process: { env: { MINIPROGRAM_STATE: fixture.dependencies.miniprogramState } },
    module: moduleValue,
    exports: moduleValue.exports,
    require(request) {
      if (request === "wx-server-sdk") return {
        DYNAMIC_CURRENT_ENV: "test",
        init() {},
        database: () => fixture.dependencies.database,
        getWXContext: () => ({ OPENID: testUser.openid, SOURCE: "wx_client", ...options.context }),
        openapi: { subscribeMessage: { send: fixture.dependencies.sendSubscribeMessage } },
      };
      if (request === "./service") return { createReminderService: (dependencies) =>
        createReminderService({ ...dependencies, now: fixture.dependencies.now }) };
      throw new Error(`测试未实现依赖：${request}`);
    },
  });
  vm.runInContext(fs.readFileSync(sourcePath, "utf8"), context, { filename: sourcePath });
  return { ...fixture, main: moduleValue.exports.main, logs };
}

test("当前用户无登记时只返回五个公开状态字段", async () => {
  const fixture = createFixture();
  assert.deepEqual(await fixture.service.getStatus(testUser), {
    enabled: true, templateId: TODO_TEMPLATE_ID, estimatedAvailableCount: 0, pendingCount: 0, blockedReason: "",
  });
  assert.equal(fixture.getWriteCount(), 0);
});

test("授权登记忽略客户端身份、家庭和次数且只保存当前用户文档", async () => {
  const fixture = createFixture();
  const result = await fixture.service.recordSubscription(testUser, {
    ...createInput(), openid: "forged-openid", familyId: "forged-family", estimatedAvailableCount: 50,
    dailyRecordCount: -20, recentRequestIds: [],
  });
  assert.equal(result.estimatedAvailableCount, 1);
  assert.deepEqual([...fixture.getRecords().keys()], [subscriptionId]);
  assert.equal(fixture.getSubscription().openid, testUser.openid);
  assert.equal(fixture.getSubscription().familyId, undefined);
  assert.equal(fixture.getSubscription().dailyRecordCount, 1);
  assert.equal(fixture.getSubscription().dailyRecordDate, "2026-09-08");
  assert.deepEqual(Object.keys(result).sort(), ["blockedReason", "enabled", "estimatedAvailableCount", "pendingCount", "templateId"]);
});

test("并发重复请求编号只登记一次且返回当前状态", async () => {
  const fixture = createFixture();
  const results = await Promise.all(Array.from({ length: 3 }, () => fixture.service.recordSubscription(testUser, createInput())));
  assert.deepEqual(results.map((result) => result.estimatedAvailableCount), [1, 1, 1]);
  assert.equal(fixture.getSubscription().dailyRecordCount, 1);
  assert.equal(fixture.getWriteCount(), 1);
});

test("每日登记达到二十次后仍允许重复编号返回且拒绝新编号", async () => {
  const fixture = createFixture();
  for (let index = 1; index <= 20; index += 1) await fixture.service.recordSubscription(testUser, createInput(index));
  assert.equal((await fixture.service.recordSubscription(testUser, createInput(1))).estimatedAvailableCount, 20);
  await assert.rejects(fixture.service.recordSubscription(testUser, createInput(21)), { message: "DAILY_LIMIT" });
  assert.equal(fixture.getSubscription().dailyRecordCount, 20);
  assert.equal(fixture.getWriteCount(), 20);
});

test("北京时间零点刷新日限并只保留最近二十个请求编号", async () => {
  const fixture = createFixture();
  for (let index = 1; index <= 20; index += 1) await fixture.service.recordSubscription(testUser, createInput(index));
  fixture.setTime("2026-09-08T16:00:00.000Z");
  await fixture.service.recordSubscription(testUser, createInput(20));
  assert.ok(fixture.getSubscription(), "授权登记应保存订阅文档");
  assert.equal(fixture.getSubscription().dailyRecordCount, 20);
  await fixture.service.recordSubscription(testUser, createInput(21));
  const subscription = fixture.getSubscription();
  assert.equal(subscription.dailyRecordDate, "2026-09-09");
  assert.equal(subscription.dailyRecordCount, 1);
  assert.equal(subscription.estimatedAvailableCount, 21);
  assert.equal(subscription.recentRequestIds.length, 20);
  assert.equal(subscription.recentRequestIds.includes(createInput(1).requestId), false);
  assert.equal(subscription.createdAt.toISOString(), "2026-09-08T15:59:59.000Z");
  assert.equal(subscription.updatedAt.toISOString(), "2026-09-08T16:00:00.000Z");
});

test("预计授权次数达到五十后继续登记但不再增长", async () => {
  const fixture = createFixture({ subscription: {
    openid: testUser.openid, templateId: TODO_TEMPLATE_ID, estimatedAvailableCount: 49,
    dailyRecordDate: "2026-09-08", dailyRecordCount: 0, recentRequestIds: [],
  } });
  await fixture.service.recordSubscription(testUser, createInput(1));
  await fixture.service.recordSubscription(testUser, createInput(2));
  assert.equal(fixture.getSubscription().estimatedAvailableCount, 50);
  assert.equal(fixture.getSubscription().dailyRecordCount, 2);
});

test("读取状态和登记不会读取或修改另一用户的订阅", async () => {
  const fixture = createFixture();
  await fixture.service.recordSubscription(testUser, createInput());
  const otherUser = { ...testUser, openid: "openid-2" };
  assert.equal((await fixture.service.getStatus(otherUser)).estimatedAvailableCount, 0);
  await fixture.service.recordSubscription(otherUser, createInput());
  assert.equal(fixture.getSubscription().estimatedAvailableCount, 1);
  assert.equal(fixture.getRecords().size, 2);
});

test("重复编号携带不同决策不会覆盖原登记结果", async () => {
  const fixture = createFixture();
  await fixture.service.recordSubscription(testUser, createInput(1, "reject"));
  const result = await fixture.service.recordSubscription(testUser, createInput(1, "accept"));
  assert.equal(result.estimatedAvailableCount, 0);
  assert.equal(fixture.getSubscription().lastDecision, "reject");
  assert.equal(fixture.getWriteCount(), 1);
});

for (const decision of ["reject", "ban", "filter"]) {
  test(`${decision}登记计入日限且不增加预计次数`, async () => {
    const fixture = createFixture();
    await fixture.service.recordSubscription(testUser, createInput(1, decision));
    assert.ok(fixture.getSubscription(), "非接受决策也应保存订阅文档");
    assert.equal(fixture.getSubscription().estimatedAvailableCount, 0);
    assert.equal(fixture.getSubscription().dailyRecordCount, 1);
    assert.equal(fixture.getSubscription().lastDecision, decision);
    await fixture.service.recordSubscription(testUser, createInput(2));
    for (let index = 3; index <= 20; index += 1) await fixture.service.recordSubscription(testUser, createInput(index, decision));
    assert.equal(fixture.getSubscription().estimatedAvailableCount, 1);
    await assert.rejects(fixture.service.recordSubscription(testUser, createInput(21)), { message: "DAILY_LIMIT" });
  });
}

test("非法模板、决策和请求编号在访问数据库前被拒绝", async () => {
  const invalidInputs = [
    [null, "INVALID_TEMPLATE"], [[], "INVALID_TEMPLATE"],
    [{ ...createInput(), templateId: "another-template" }, "INVALID_TEMPLATE"],
    [{ ...createInput(), decision: "unknown" }, "INVALID_DECISION"],
    ...[undefined, "", "short", "a".repeat(65), "a".repeat(15) + "/", 1234567890123456, ["a".repeat(16)]].map((requestId) =>
      [{ ...createInput(), requestId }, "INVALID_REQUEST_ID"]),
  ];
  for (const [input, message] of invalidInputs) {
    const fixture = createFixture();
    await assert.rejects(fixture.service.recordSubscription(testUser, input), { message });
    assert.equal(fixture.getAccessCount(), 0);
  }
});

test("合法请求编号接受十六和六十四字符边界", async () => {
  const fixture = createFixture();
  for (const requestId of ["A_-0123456789abcD", "a".repeat(64)]) {
    await fixture.service.recordSubscription(testUser, { ...createInput(), requestId });
  }
  assert.ok(fixture.getSubscription(), "合法编号应保存订阅文档");
  assert.equal(fixture.getSubscription().estimatedAvailableCount, 2);
});

test("待提醒数只统计当前用户未到截止时间的三类非终态记录", async () => {
  const delivery = { recipientOpenid: testUser.openid, deadlineAt: new Date("2026-09-09T00:00:00Z") };
  const fixture = createFixture({ deliveries: [
    ...["waiting_subscription", "retry", "sending", "sent", "failed", "uncertain", "expired", "canceled"].map((status) => ({ ...delivery, status })),
    { ...delivery, status: "retry", recipientOpenid: "other-openid" },
    { ...delivery, status: "retry", deadlineAt: new Date("2026-09-08T15:59:59Z") },
    { ...delivery, status: "retry", deadlineAt: new Date("2026-09-08T00:00:00Z") },
  ] });
  assert.equal((await fixture.service.getStatus(testUser)).pendingCount, 3);
  assert.equal((await fixture.service.recordSubscription(testUser, createInput())).pendingCount, 3);
});

for (const miniprogramState of ["developer", "trial", "formal", "", "production", null]) {
  test(`运行环境${String(miniprogramState)}决定公开配置可用状态`, async () => {
    const fixture = createFixture({ miniprogramState });
    const result = await fixture.service.getStatus(testUser);
    const enabled = ["developer", "trial", "formal"].includes(miniprogramState);
    assert.equal(result.enabled, enabled);
    assert.equal(result.blockedReason, enabled ? "" : "CONFIGURATION");
  });
}

test("调度集合不可用时返回兼容性跳过结果", async () => {
  const fixture = createFixture();
  assert.deepEqual(await fixture.service.run(), { skipped: true, reason: "SCHEDULER_NOT_IMPLEMENTED" });
  assert.ok(fixture.getAccessCount() > 0);
});

for (const source of ["wx_client", "wx_devtools", "wx_client,wx_trigger", "wx_trigger,wx_client", "wx_trigger,wx_devtools", "wx_server", undefined]) {
  test(`来源${String(source)}不能通过动作或事件伪造定时入口`, async () => {
    const fixture = loadReminderFunction({ context: { SOURCE: source } });
    const result = await fixture.main({ action: "run", SOURCE: "wx_trigger", context: { SOURCE: "wx_trigger" } });
    assert.equal(result.success, false);
    assert.equal(result.message, "不支持的操作");
    assert.equal(fixture.getWriteCount(), 0);
  });
}

test("只有顶层定时来源直接执行调度且无需用户或动作", async () => {
  const fixture = loadReminderFunction({ context: { SOURCE: "wx_trigger", OPENID: undefined } });
  for (const event of [{}, { action: "recordSubscription" }]) {
    const result = await fixture.main(event);
    assert.equal(result.success, true);
    assert.equal(result.data.reason, "SCHEDULER_NOT_IMPLEMENTED");
  }
  assert.ok(fixture.getAccessCount() > 0);
});

test("客户端开放状态与登记且只使用微信认证身份", async () => {
  const fixture = loadReminderFunction();
  assert.equal((await fixture.main({ action: "getStatus" })).data.estimatedAvailableCount, 0);
  const result = await fixture.main({ action: "recordSubscription", ...createInput(), openid: "forged-openid" });
  assert.equal(result.success, true);
  assert.equal(result.data.estimatedAvailableCount, 1);
  assert.equal(fixture.getSubscription().openid, testUser.openid);
});

test("客户端输入错误与日限转换为稳定公开失败", async () => {
  const fixture = loadReminderFunction();
  for (const [input, message] of [
    [{ templateId: "wrong" }, "订阅消息模板不正确"],
    [{ ...createInput(), decision: "wrong" }, "订阅结果不正确"],
    [{ ...createInput(), requestId: "wrong" }, "订阅请求编号不正确"],
  ]) {
    const result = await fixture.main({ action: "recordSubscription", ...input });
    assert.equal(result.success, false);
    assert.equal(result.message, message);
    assert.equal(result.data, null);
  }
  for (let index = 1; index <= 20; index += 1) await fixture.main({ action: "recordSubscription", ...createInput(index) });
  assert.equal((await fixture.main({ action: "recordSubscription", ...createInput(21) })).message, "今日订阅登记次数已达上限，请明天再试");
});

test("数据库故障公开响应与日志均不暴露载荷或内部错误", async () => {
  const sensitiveText = "sensitive-openid-document-request";
  const fixture = loadReminderFunction({ databaseError: new Error(sensitiveText) });
  const result = await fixture.main({ action: sensitiveText, openid: sensitiveText });
  assert.equal(result.success, false);
  assert.equal(result.message, "提醒服务暂时不可用，请稍后重试");
  assert.equal(JSON.stringify(result).includes(sensitiveText), false);
  assert.equal(JSON.stringify(fixture.logs).includes(sensitiveText), false);
  assert.equal(fixture.logs.length, 1);
});

test("订阅读取故障不会被当作文档不存在并重建授权", async () => {
  const error = new Error("database connection does not exist");
  const fixture = createFixture({ subscriptionReadError: error });
  await assert.rejects(fixture.service.recordSubscription(testUser, createInput()), error);
  assert.equal(fixture.getWriteCount(), 0);
});

test("没有微信身份时不能用载荷身份登记订阅", async () => {
  const fixture = loadReminderFunction({ context: { OPENID: undefined } });
  const result = await fixture.main({ action: "recordSubscription", ...createInput(), openid: testUser.openid });
  assert.equal(result.success, false);
  assert.equal(result.message, "请先登录并加入家庭");
  assert.equal(fixture.getAccessCount(), 0);
});

function createSchedulerFixture(options = {}) {
  const nowValue = new Date(options.now || "2026-09-08T15:00:00.000Z");
  const users = (options.users || [{ openid: testUser.openid, familyId: testUser.familyId, role: "creator", relation: "father" }])
    .map((user, index) => ({ ...user, _id: user._id || `user-${index + 1}` }));
  const notices = new Map();
  const deliveries = new Map();
  const subscriptions = new Map();
  const baseNotice = {
    _id: "notice-1",
    familyId: testUser.familyId,
    reminderVersion: 1,
    reminderState: "scheduled",
    scheduledAt: new Date(nowValue.getTime() - 60 * 60 * 1000),
    remindTime: new Date(nowValue.getTime() + 60 * 60 * 1000),
    deadlineAt: new Date(nowValue.getTime() + 60 * 60 * 1000),
    remindTargets: ["father"],
    title: "家长会",
    content: "请按时参加",
    category: "activity",
  };
  for (const notice of options.notices || [baseNotice]) notices.set(notice._id, structuredClone(notice));
  for (const delivery of options.deliveries || []) deliveries.set(delivery.deliveryId || delivery._id, structuredClone(delivery));
  for (const subscription of options.subscriptions || []) subscriptions.set(subscription.id || createSubscriptionId(subscription.openid, TODO_TEMPLATE_ID), structuredClone(subscription));
  let sendIndex = 0;
  const sendCalls = [];
  let transactionQueue = Promise.resolve();
  let retryPending = Boolean(options.retryOnce);
  const command = {
    in: (values) => ({ operator: "in", values }),
    lte: (value) => ({ operator: "lte", value }),
    gt: (value) => ({ operator: "gt", value }),
  };
  const database = {
    command,
    collection(name) { return createCollection(name, { notices, deliveries, subscriptions }, false); },
    async runTransaction(callback) {
      const result = transactionQueue.then(async () => {
        async function executeTransaction() {
          const staged = { notices: cloneMap(notices), deliveries: cloneMap(deliveries), subscriptions: cloneMap(subscriptions) };
          const value = await callback({ collection: (name) => createCollection(name, staged, true) });
          if (retryPending) {
            retryPending = false;
            if (typeof options.onTransactionConflict === "function") options.onTransactionConflict({ notices, deliveries, subscriptions });
            return executeTransaction();
          }
          replaceMap(notices, staged.notices);
          replaceMap(deliveries, staged.deliveries);
          replaceMap(subscriptions, staged.subscriptions);
          return value;
        }
        return executeTransaction();
      });
      transactionQueue = result.catch(() => {});
      return result;
    },
  };
  function cloneMap(source) {
    return new Map([...source.entries()].map(([key, value]) => [key, structuredClone(value)]));
  }
  function replaceMap(target, source) {
    target.clear();
    for (const [key, value] of source.entries()) target.set(key, value);
  }
  function matches(record, query) {
    return Object.entries(query).every(([key, expected]) => {
      const actual = record[key];
      if (expected && expected.operator === "in") return expected.values.includes(actual);
      if (expected && expected.operator === "lte") return actual <= expected.value;
      if (expected && expected.operator === "gt") return actual > expected.value;
      return actual === expected;
    });
  }
  function mapFor(name, stores) {
    if (name === "notices") return stores.notices;
    if (name === "reminder_deliveries") return stores.deliveries;
    if (name === "message_subscriptions") return stores.subscriptions;
    return null;
  }
  function createCollection(name, stores, inTransaction) {
    if (name === "users") {
      if (inTransaction) {
        return {
          where() { throw new Error("事务不支持 where"); },
          doc(id) {
            return {
              async get() {
                const user = users.find((item) => item._id === id);
                if (!user) {
                  const error = new Error("document.get:fail document does not exist");
                  error.code = "DOCUMENT_NOT_FOUND";
                  throw error;
                }
                return { data: structuredClone(user) };
              },
            };
          },
        };
      }
      return { where: (query) => queryUsers(query, users) };
    }
    const map = mapFor(name, stores);
    if (!map) {
      throw new Error(`测试未实现集合：${name}`);
    }
    return {
      where(query) {
        if (inTransaction) throw new Error("事务不支持 where");
        return queryRecords(name, query, [...map.values()]);
      },
      doc(id) {
        return {
          async get() {
            if (!map.has(id)) {
              const error = new Error("document.get:fail document does not exist");
              error.code = "DOCUMENT_NOT_FOUND";
              throw error;
            }
            return { data: structuredClone(map.get(id)) };
          },
          async set({ data }) {
            assert.equal(inTransaction, true, "调度写入必须在事务中完成");
            if (options.rejectReservedIdWrite && Object.prototype.hasOwnProperty.call(data, "_id")) {
              throw new Error("CloudBase set 不能更新 _id 字段");
            }
            map.set(id, structuredClone(data));
          },
          async update({ data }) {
            assert.equal(map.has(id), true, `文档 ${id} 应存在`);
            map.set(id, { ...map.get(id), ...structuredClone(data) });
          },
        };
      },
    };
  }
  function queryUsers(query, source) {
    return queryRecords("users", query, source);
  }
  function queryRecords(name, query, source) {
    let rows = source.filter((record) => matches(record, query));
    const chain = {
      orderBy(_field, direction) {
        rows = [...rows].sort((left, right) => direction === "asc" ? left.scheduledAt - right.scheduledAt : right.scheduledAt - left.scheduledAt);
        return chain;
      },
      skip(count) { rows = rows.slice(count); return chain; },
      limit(count) { rows = rows.slice(0, count); return chain; },
      async get() {
        if (typeof options.onQueryGet === "function") {
          await options.onQueryGet({ name, query, notices, deliveries, subscriptions, users });
        }
        return { data: structuredClone(rows) };
      },
      async count() { return { total: rows.length }; },
    };
    return chain;
  }
  const dependencies = {
    database,
    now: () => new Date(nowValue),
    miniprogramState: options.miniprogramState === undefined ? "developer" : options.miniprogramState,
    sendSubscribeMessage: async (payload) => {
      sendCalls.push(payload);
      if (typeof options.onSend === "function") options.onSend({ notices, deliveries, subscriptions, sendIndex });
      const response = options.responses && options.responses[sendIndex] !== undefined ? options.responses[sendIndex] : { errCode: 0 };
      sendIndex += 1;
      if (response instanceof Error) throw response;
      return response;
    },
  };
  return {
    database,
    service: createReminderService(dependencies),
    sendCalls,
    notices,
    deliveries,
    subscriptions,
    users,
    nowValue,
    newService() { return createReminderService(dependencies); },
  };
}

function schedulerDelivery(fixture, overrides = {}) {
  const notice = fixture.notices.get("notice-1");
  const deliveryId = createDeliveryId(notice._id, notice.reminderVersion, testUser.openid, TODO_TEMPLATE_ID);
  const delivery = {
    _id: deliveryId,
    deliveryId,
    noticeId: notice._id,
    familyId: notice.familyId,
    reminderVersion: notice.reminderVersion,
    recipientOpenid: testUser.openid,
    recipientRelation: "father",
    templateId: TODO_TEMPLATE_ID,
    scheduledAt: notice.scheduledAt,
    deadlineAt: notice.deadlineAt,
    status: "waiting_subscription",
    attemptCount: 0,
    nextAttemptAt: fixture.nowValue,
    lockExpiresAt: null,
    lastErrorCode: null,
    lastErrorMessage: "",
    sentAt: null,
    quotaFinalized: false,
    createdAt: fixture.nowValue,
    updatedAt: fixture.nowValue,
    ...overrides,
  };
  fixture.deliveries.set(deliveryId, delivery);
  return delivery;
}

test("重复调度只物化一条接收人任务", async () => {
  const fixture = createSchedulerFixture({ subscriptions: [{ openid: testUser.openid, estimatedAvailableCount: 0 }] });
  const first = await fixture.service.run();
  const second = await fixture.service.run();
  assert.equal(first.createdDeliveries, 1);
  assert.equal(second.createdDeliveries, 0);
  assert.equal(fixture.deliveries.size, 1);
  assert.equal(fixture.sendCalls.length, 0);
});

test("物化发送记录时不写入 CloudBase 保留的 _id 字段", async () => {
  const fixture = createSchedulerFixture({
    subscriptions: [{ openid: testUser.openid, estimatedAvailableCount: 0 }],
    rejectReservedIdWrite: true,
  });

  const result = await fixture.service.run();

  assert.equal(result.createdDeliveries, 1);
  assert.equal(fixture.deliveries.size, 1);
});

test("物化事务使用当前通知接收人而非扫描快照", async () => {
  const mother = { openid: "openid-mother", familyId: testUser.familyId, role: "member", relation: "mother" };
  const fixture = createSchedulerFixture({
    users: [
      { openid: testUser.openid, familyId: testUser.familyId, role: "creator", relation: "father" },
      mother,
    ],
  });
  const staleNotice = structuredClone(fixture.notices.get("notice-1"));
  fixture.notices.get("notice-1").remindTargets = ["mother"];

  await fixture.service.materializeNotice(staleNotice);

  assert.equal(fixture.deliveries.size, 1);
  assert.equal([...fixture.deliveries.values()][0].recipientOpenid, mother.openid);
});

test("物化封印阻止汇总候选读取后的新成员任务覆盖完成状态", async () => {
  const mother = { openid: "openid-mother", familyId: testUser.familyId, role: "member", relation: "mother" };
  let fixture;
  let intercepted = false;
  fixture = createSchedulerFixture({
    users: [{ openid: testUser.openid, familyId: testUser.familyId, role: "creator", relation: "father" }],
    subscriptions: [{ openid: testUser.openid, estimatedAvailableCount: 1 }],
    onQueryGet: async ({ name, query }) => {
      if (intercepted || name !== "reminder_deliveries" || query.noticeId !== "notice-1") return;
      intercepted = true;
      fixture.users.push({ ...mother, _id: "user-mother" });
      await fixture.service.materializeNotice(fixture.notices.get("notice-1"));
    },
  });
  fixture.notices.get("notice-1").remindTargets = ["father", "mother"];

  await fixture.service.run();

  const deliveries = [...fixture.deliveries.values()];
  assert.equal(intercepted, true);
  assert.equal(fixture.notices.get("notice-1").reminderState, "completed");
  assert.equal(deliveries.some((delivery) => delivery.status === "waiting_subscription"), false);
  assert.equal(deliveries.length, 1);
});

test("物化中间态的合法任务暂缓占用并在封印后发送", async () => {
  const fixture = createSchedulerFixture({ subscriptions: [{ openid: testUser.openid, estimatedAvailableCount: 1 }] });
  const delivery = schedulerDelivery(fixture);

  const pendingClaim = await fixture.service.claimDelivery(delivery.deliveryId);

  assert.equal(pendingClaim, null);
  assert.equal(fixture.deliveries.get(delivery.deliveryId).status, "waiting_subscription");
  assert.equal(fixture.subscriptions.get(subscriptionId).estimatedAvailableCount, 1);

  fixture.notices.get("notice-1").reminderState = "materialized";
  const finalizedClaim = await fixture.service.claimDelivery(delivery.deliveryId);

  assert.ok(finalizedClaim);
  assert.equal(fixture.deliveries.get(delivery.deliveryId).status, "sending");
  assert.equal(fixture.subscriptions.get(subscriptionId).estimatedAvailableCount, 0);
});

for (const scenario of [
  { name: "成员退出", change: ({ users }) => users.splice(0, 1) },
  { name: "成员家庭变更", change: ({ users }) => { users[0] = { ...users[0], familyId: "another-family" }; } },
  { name: "成员关系变更", change: ({ users }) => { users[0] = { ...users[0], relation: "mother" }; } },
  { name: "成员角色失效", change: ({ users }) => { users[0] = { ...users[0], role: "invalid" }; } },
  { name: "成员 OpenID 变更", change: ({ users }) => { users[0] = { ...users[0], openid: "another-openid" }; } },
  { name: "提醒目标移除", change: ({ notices }) => { notices.get("notice-1").remindTargets = ["mother"]; } },
]) {
  test(`物化中间态在候选查询后${scenario.name}立即取消且不扣额度`, async () => {
    const fixture = createSchedulerFixture({
      subscriptions: [{ openid: testUser.openid, estimatedAvailableCount: 1 }],
      onQueryGet: (context) => {
        if (context.name === "users") scenario.change(context);
      },
    });
    fixture.notices.get("notice-1").remindTargets = ["father", "mother"];
    const delivery = schedulerDelivery(fixture);

    const claim = await fixture.service.claimDelivery(delivery.deliveryId);

    assert.deepEqual(claim, { terminalStatus: "canceled" });
    assert.equal(fixture.deliveries.get(delivery.deliveryId).status, "canceled");
    assert.equal(fixture.deliveries.get(delivery.deliveryId).attemptCount, 0);
    assert.equal(fixture.subscriptions.get(subscriptionId).estimatedAvailableCount, 1);
    assert.equal(fixture.notices.get("notice-1").reminderState, "scheduled");
    assert.equal(fixture.sendCalls.length, 0);
  });
}

test("没有预计授权时保持等待且不调用微信", async () => {
  const fixture = createSchedulerFixture({ subscriptions: [{ openid: testUser.openid, estimatedAvailableCount: 0 }] });
  await fixture.service.run();
  assert.equal([...fixture.deliveries.values()][0].status, "waiting_subscription");
  assert.equal(fixture.sendCalls.length, 0);
});

test("无匹配接收人时仍物化通知但不创建发送任务", async () => {
  const fixture = createSchedulerFixture({ users: [] });

  const result = await fixture.service.run();

  assert.equal(result.createdDeliveries, 0);
  assert.equal(fixture.notices.get("notice-1").reminderState, "materialized");
  assert.equal(fixture.deliveries.size, 0);
});

test("发送成功写入已发送时间并只扣减一次", async () => {
  const fixture = createSchedulerFixture({ subscriptions: [{ openid: testUser.openid, estimatedAvailableCount: 1 }] });
  const result = await fixture.service.run();
  const delivery = [...fixture.deliveries.values()][0];
  assert.equal(delivery.status, "sent");
  assert.equal(delivery.sentAt.toISOString(), fixture.nowValue.toISOString());
  assert.equal(fixture.subscriptions.get(subscriptionId).estimatedAvailableCount, 0);
  assert.equal(fixture.sendCalls.length, 1);
  assert.equal(result.sent, 1);
});

test("已完成额度结算的占用不会重复恢复预计次数", async () => {
  const fixture = createSchedulerFixture({ subscriptions: [{ openid: testUser.openid, estimatedAvailableCount: 0 }] });
  const delivery = schedulerDelivery(fixture, { status: "sending", attemptCount: 1, quotaFinalized: true });

  await fixture.service.completeDelivery({ ...delivery, subscriptionId }, {
    ok: false,
    category: "concurrent",
    errCode: 43108,
    error: { errCode: 43108 },
  });

  assert.equal(fixture.deliveries.get(delivery.deliveryId).status, "retry");
  assert.equal(fixture.subscriptions.get(subscriptionId).estimatedAvailableCount, 0);
});

test("并发占用同一任务只扣减一次预计次数", async () => {
  const fixture = createSchedulerFixture({ subscriptions: [{ openid: testUser.openid, estimatedAvailableCount: 1 }] });
  const delivery = schedulerDelivery(fixture);
  fixture.notices.get("notice-1").reminderState = "materialized";

  const claims = await Promise.all([
    fixture.service.claimDelivery(delivery.deliveryId),
    fixture.service.claimDelivery(delivery.deliveryId),
  ]);

  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(fixture.deliveries.get(delivery.deliveryId).status, "sending");
  assert.equal(fixture.subscriptions.get(subscriptionId).estimatedAvailableCount, 0);
});

test("事务夹具拒绝事务内条件查询", async () => {
  const fixture = createSchedulerFixture();

  await assert.rejects(fixture.database.runTransaction(async (transaction) =>
    transaction.collection("users").where({ familyId: testUser.familyId }).get()), /事务不支持 where/);
});

test("事务重试后未获得占用不会返回首次尝试的发送凭据", async () => {
  let deliveryId = "";
  const fixture = createSchedulerFixture({
    subscriptions: [{ openid: testUser.openid, estimatedAvailableCount: 1 }],
    retryOnce: true,
    onTransactionConflict: ({ deliveries }) => {
      const delivery = deliveries.get(deliveryId);
      deliveries.set(deliveryId, {
        ...delivery,
        status: "sending",
        lockExpiresAt: new Date("2026-09-08T15:10:00.000Z"),
      });
    },
  });
  const delivery = schedulerDelivery(fixture);
  deliveryId = delivery.deliveryId;
  fixture.notices.get("notice-1").reminderState = "materialized";

  const claim = await fixture.service.claimDelivery(deliveryId);

  assert.equal(claim, null);
  assert.equal(fixture.deliveries.get(deliveryId).status, "sending");
  assert.equal(fixture.subscriptions.get(subscriptionId).estimatedAvailableCount, 1);
});

test("物化事务重试不会保留已丢弃尝试的创建计数", async () => {
  const deliveryId = createDeliveryId("notice-1", 1, testUser.openid, TODO_TEMPLATE_ID);
  const fixture = createSchedulerFixture({
    retryOnce: true,
    onTransactionConflict: ({ deliveries }) => {
      deliveries.set(deliveryId, { _id: deliveryId, deliveryId, status: "waiting_subscription" });
    },
  });

  const created = await fixture.service.materializeNotice(fixture.notices.get("notice-1"));

  assert.equal(created, 0);
  assert.equal(fixture.deliveries.size, 1);
});

test("未知发送结果进入不确定且不自动重发", async () => {
  const fixture = createSchedulerFixture({
    subscriptions: [{ openid: testUser.openid, estimatedAvailableCount: 1 }],
    responses: [{}],
  });
  await fixture.service.run();
  await fixture.service.run();
  assert.equal([...fixture.deliveries.values()][0].status, "uncertain");
  assert.equal(fixture.sendCalls.length, 1);
});

test("命中敏感词时使用安全模板重试一次", async () => {
  const fixture = createSchedulerFixture({
    subscriptions: [{ openid: testUser.openid, estimatedAvailableCount: 1 }],
    responses: [{ errCode: 45168 }, { errCode: 0 }],
  });
  await fixture.service.run();
  assert.equal([...fixture.deliveries.values()][0].status, "sent");
  assert.equal(fixture.sendCalls.length, 2);
  assert.equal(fixture.sendCalls[1].data.thing1.value, "家庭待办");
});

test("抛出式敏感词错误同样使用安全模板重试一次", async () => {
  const sensitiveError = Object.assign(new Error("sensitive content"), { errCode: 45168 });
  const fixture = createSchedulerFixture({
    subscriptions: [{ openid: testUser.openid, estimatedAvailableCount: 1 }],
    responses: [sensitiveError, { errCode: 0 }],
  });

  await fixture.service.run();

  assert.equal([...fixture.deliveries.values()][0].status, "sent");
  assert.equal(fixture.sendCalls.length, 2);
  assert.equal(fixture.sendCalls[1].data.thing1.value, "家庭待办");
});

test("安全模板重试仍命中敏感词时标记失败且不恢复额度", async () => {
  const fixture = createSchedulerFixture({
    subscriptions: [{ openid: testUser.openid, estimatedAvailableCount: 1 }],
    responses: [{ errCode: 45168 }, { errCode: 45168 }],
  });

  await fixture.service.run();

  assert.equal([...fixture.deliveries.values()][0].status, "failed");
  assert.equal(fixture.subscriptions.get(subscriptionId).estimatedAvailableCount, 0);
  assert.equal(fixture.sendCalls.length, 2);
});

test("安全模板第二次明确临时失败直接终止", async () => {
  const fixture = createSchedulerFixture({
    subscriptions: [{ openid: testUser.openid, estimatedAvailableCount: 1 }],
    responses: [{ errCode: 45168 }, { errCode: -1 }],
  });

  await fixture.service.run();

  assert.equal([...fixture.deliveries.values()][0].status, "failed");
  assert.equal(fixture.subscriptions.get(subscriptionId).estimatedAvailableCount, 0);
  assert.equal(fixture.sendCalls.length, 2);
});

test("安全模板第二次未知结果保持不确定且不自动重发", async () => {
  const fixture = createSchedulerFixture({
    subscriptions: [{ openid: testUser.openid, estimatedAvailableCount: 1 }],
    responses: [{ errCode: 45168 }, {}],
  });

  await fixture.service.run();
  await fixture.service.run();

  assert.equal([...fixture.deliveries.values()][0].status, "uncertain");
  assert.equal(fixture.sendCalls.length, 2);
});

test("明确失败恢复预计次数并记录终态或重试", async () => {
  const concurrentFixture = createSchedulerFixture({ subscriptions: [{ openid: testUser.openid, estimatedAvailableCount: 1 }], responses: [{ errCode: 43108 }] });
  await concurrentFixture.service.run();
  assert.equal([...concurrentFixture.deliveries.values()][0].status, "retry");
  assert.equal(concurrentFixture.subscriptions.get(subscriptionId).estimatedAvailableCount, 1);

  const invalidFixture = createSchedulerFixture({ subscriptions: [{ openid: testUser.openid, estimatedAvailableCount: 1 }], responses: [{ errCode: 47003 }] });
  await invalidFixture.service.run();
  assert.equal([...invalidFixture.deliveries.values()][0].status, "failed");
  assert.equal(invalidFixture.subscriptions.get(subscriptionId).estimatedAvailableCount, 1);
});

test("授权不足和系统阻断分别持久化额度与失败状态", async () => {
  const authorizationFixture = createSchedulerFixture({
    subscriptions: [{ openid: testUser.openid, estimatedAvailableCount: 1 }],
    responses: [{ errCode: 43101 }],
  });
  await authorizationFixture.service.run();
  assert.equal([...authorizationFixture.deliveries.values()][0].status, "waiting_subscription");
  assert.equal(authorizationFixture.subscriptions.get(subscriptionId).estimatedAvailableCount, 0);

  const blockedFixture = createSchedulerFixture({
    subscriptions: [{ openid: testUser.openid, estimatedAvailableCount: 1 }],
    responses: [{ errCode: 43107 }],
  });
  await blockedFixture.service.run();
  assert.equal([...blockedFixture.deliveries.values()][0].status, "failed");
  assert.equal(blockedFixture.subscriptions.get(subscriptionId).blockedReason, "SYSTEM_BLOCKED");
  assert.equal(blockedFixture.subscriptions.get(subscriptionId).estimatedAvailableCount, 0);
});

test("临时错误恢复额度且退避不会越过截止时间", async () => {
  const retryFixture = createSchedulerFixture({
    subscriptions: [{ openid: testUser.openid, estimatedAvailableCount: 1 }],
    responses: [{ errCode: -1 }],
  });
  await retryFixture.service.run();
  const retryDelivery = [...retryFixture.deliveries.values()][0];
  assert.equal(retryDelivery.status, "retry");
  assert.equal(retryDelivery.nextAttemptAt.toISOString(), new Date(retryFixture.nowValue.getTime() + 30 * 60 * 1000).toISOString());
  assert.equal(retryFixture.subscriptions.get(subscriptionId).estimatedAvailableCount, 1);

  const deadlineFixture = createSchedulerFixture({
    subscriptions: [{ openid: testUser.openid, estimatedAvailableCount: 1 }],
    responses: [{ errCode: -1 }],
  });
  deadlineFixture.notices.get("notice-1").deadlineAt = new Date(deadlineFixture.nowValue.getTime() + 15 * 60 * 1000);
  deadlineFixture.notices.get("notice-1").remindTime = deadlineFixture.notices.get("notice-1").deadlineAt;
  await deadlineFixture.service.run();
  assert.equal([...deadlineFixture.deliveries.values()][0].status, "expired");
  assert.equal(deadlineFixture.subscriptions.get(subscriptionId).estimatedAvailableCount, 1);

  const maximumFixture = createSchedulerFixture({ subscriptions: [{ openid: testUser.openid, estimatedAvailableCount: 0 }] });
  const maximumDelivery = schedulerDelivery(maximumFixture, { status: "sending", attemptCount: 4 });
  await maximumFixture.service.completeDelivery({ ...maximumDelivery, subscriptionId }, {
    ok: false,
    category: "temporary",
    errCode: -1,
    error: { errCode: -1 },
  });
  assert.equal(maximumFixture.deliveries.get(maximumDelivery.deliveryId).status, "expired");
  assert.equal(maximumFixture.subscriptions.get(subscriptionId).estimatedAvailableCount, 1);
});

test("通知版本或成员关系变化时取消发送", async () => {
  const fixture = createSchedulerFixture({ subscriptions: [{ openid: testUser.openid, estimatedAvailableCount: 1 }] });
  const delivery = schedulerDelivery(fixture);
  fixture.notices.get("notice-1").reminderVersion = 2;
  fixture.notices.get("notice-1").reminderState = "materialized";
  await fixture.service.run();
  assert.equal(fixture.deliveries.get(delivery.deliveryId).status, "canceled");
  assert.equal(fixture.sendCalls.length, 0);
});

test("通知删除优先于截止时间取消未发送任务", async () => {
  const fixture = createSchedulerFixture({ subscriptions: [{ openid: testUser.openid, estimatedAvailableCount: 1 }] });
  const delivery = schedulerDelivery(fixture, { deadlineAt: new Date(fixture.nowValue.getTime() - 1) });
  fixture.notices.get("notice-1").deleted = true;

  await fixture.service.run();

  assert.equal(fixture.deliveries.get(delivery.deliveryId).status, "canceled");
  assert.equal(fixture.sendCalls.length, 0);
});

test("禁用通知或成员关系失效时取消待发送任务", async () => {
  const disabledFixture = createSchedulerFixture({ subscriptions: [{ openid: testUser.openid, estimatedAvailableCount: 1 }] });
  const disabledDelivery = schedulerDelivery(disabledFixture);
  disabledFixture.notices.get("notice-1").reminderState = "disabled";
  await disabledFixture.service.run();
  assert.equal(disabledFixture.deliveries.get(disabledDelivery.deliveryId).status, "canceled");

  const users = [{ openid: testUser.openid, familyId: testUser.familyId, role: "creator", relation: "father" }];
  const memberFixture = createSchedulerFixture({ users, subscriptions: [{ openid: testUser.openid, estimatedAvailableCount: 1 }] });
  const memberDelivery = schedulerDelivery(memberFixture);
  memberFixture.users[0].relation = "mother";
  await memberFixture.service.run();
  assert.equal(memberFixture.deliveries.get(memberDelivery.deliveryId).status, "canceled");
});

test("所有目标发送成功后才完成通知汇总", async () => {
  const mother = { openid: "openid-mother", familyId: testUser.familyId, role: "member", relation: "mother" };
  const fixture = createSchedulerFixture({
    users: [
      { openid: testUser.openid, familyId: testUser.familyId, role: "creator", relation: "father" },
      mother,
    ],
    subscriptions: [
      { openid: testUser.openid, estimatedAvailableCount: 1 },
      { openid: mother.openid, estimatedAvailableCount: 1 },
    ],
  });
  fixture.notices.get("notice-1").remindTargets = ["father", "mother"];
  await fixture.service.run();
  assert.equal(fixture.notices.get("notice-1").reminderState, "completed");
  assert.equal(fixture.notices.get("notice-1").isReminded, true);
  assert.equal(fixture.sendCalls.length, 2);
});

test("旧版本发送完成不会覆盖新版本通知汇总", async () => {
  const fixture = createSchedulerFixture({
    subscriptions: [{ openid: testUser.openid, estimatedAvailableCount: 1 }],
    onSend: ({ notices }) => {
      const notice = notices.get("notice-1");
      notice.reminderVersion = 2;
      notice.reminderState = "materialized";
      notice.isReminded = false;
    },
  });

  await fixture.service.run();

  assert.equal(fixture.notices.get("notice-1").reminderVersion, 2);
  assert.equal(fixture.notices.get("notice-1").reminderState, "materialized");
  assert.equal(fixture.notices.get("notice-1").isReminded, false);
});

test("系统阻断状态持久化并可被新服务实例读取", async () => {
  const fixture = createSchedulerFixture({ subscriptions: [{ openid: testUser.openid, estimatedAvailableCount: 1 }], responses: [{ errCode: 43107 }] });
  await fixture.service.run();
  const status = await fixture.newService().getStatus(testUser);
  assert.equal(status.enabled, false);
  assert.equal(status.blockedReason, "SYSTEM_BLOCKED");
});

test("已过期任务不调用微信", async () => {
  const fixture = createSchedulerFixture({ subscriptions: [{ openid: testUser.openid, estimatedAvailableCount: 1 }] });
  const expired = schedulerDelivery(fixture, { deadlineAt: new Date(fixture.nowValue.getTime() - 1) });
  fixture.notices.get("notice-1").reminderState = "materialized";
  await fixture.service.run();
  assert.equal(fixture.deliveries.get(expired.deliveryId).status, "expired");
  assert.equal(fixture.sendCalls.length, 0);
});

test("发送锁过期后转为不确定且不自动重发", async () => {
  const fixture = createSchedulerFixture({ subscriptions: [{ openid: testUser.openid, estimatedAvailableCount: 0 }] });
  const delivery = schedulerDelivery(fixture, {
    status: "sending",
    attemptCount: 1,
    lockExpiresAt: new Date(fixture.nowValue.getTime() - 1),
  });
  fixture.notices.get("notice-1").reminderState = "materialized";

  await fixture.service.run();
  await fixture.service.run();

  assert.equal(fixture.deliveries.get(delivery.deliveryId).status, "uncertain");
  assert.equal(fixture.sendCalls.length, 0);
});

test("调度只扫描已到期任务以避免未来重试任务饿死当前发送", async () => {
  const futureDeliveries = Array.from({ length: 50 }, (_, index) => ({
    _id: `future-${index}`,
    deliveryId: `future-${index}`,
    noticeId: "notice-1",
    familyId: testUser.familyId,
    reminderVersion: 1,
    recipientOpenid: `future-openid-${index}`,
    recipientRelation: "father",
    deadlineAt: new Date("2026-09-08T18:00:00.000Z"),
    status: "retry",
    attemptCount: 1,
    nextAttemptAt: new Date("2026-09-08T16:00:00.000Z"),
    lockExpiresAt: null,
  }));
  const fixture = createSchedulerFixture({
    deliveries: futureDeliveries,
    subscriptions: [{ openid: testUser.openid, estimatedAvailableCount: 1 }],
  });
  schedulerDelivery(fixture);
  fixture.notices.get("notice-1").reminderState = "materialized";

  const result = await fixture.service.run();

  assert.equal(result.sent, 1);
  assert.equal(fixture.sendCalls.length, 1);
});
