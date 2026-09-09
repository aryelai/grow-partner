const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createReminderService } = require("../cloudfunctions/reminder/service");
const { TODO_TEMPLATE_ID, createSubscriptionId } = require("../cloudfunctions/reminder/core");

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
