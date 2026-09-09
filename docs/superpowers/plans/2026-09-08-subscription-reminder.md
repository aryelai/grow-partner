# 微信订阅消息与自动提醒实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为通知模块交付基于微信一次性订阅消息、30 分钟定时触发、防重复发送和可审计状态的自动提醒闭环。

**Architecture:** `notice` 云函数负责生成稳定的提醒配置版本和调度时间；`reminder` 云函数把到期通知物化为按接收人唯一的发送记录，再通过事务占用预计授权并调用微信开放接口。前端只在用户点击后申请当前用户的一次授权，订阅和发送集合禁止客户端直读写；复杂调度逻辑拆为纯函数和可注入服务，使用 `node:test` 验证。

**Tech Stack:** 微信小程序原生 JavaScript/WXML/WXSS、微信云开发、`wx-server-sdk@3.0.1`、Node.js `node:test`

**Spec:** `docs/superpowers/specs/2026-09-08-subscription-reminder-design.md`

## Global Constraints

- 不使用 TypeScript，不引入第三方 UI 框架或新增业务 npm 依赖。
- 待办事项提醒模板 ID 固定为 `5Iy1Jv7aswWNmrRMDXgrcj2BKeywdH6evDst6OomB2c`。
- 日程提醒模板 ID `1fMjBkOzsEqXYVrQieX6ljtQ4lAKf8tIRn7GP2jDRew` 本轮不请求、不发送。
- 提醒提前量只允许 `120` 或 `1440` 分钟且每条通知只能选择一个，默认 `120`。
- 所有身份和家庭边界由云函数从 `cloud.getWXContext()` 与 `users` 集合解析，不信任客户端传入的 OpenID 或 `familyId`。
- `run` 只接受 `SOURCE === "wx_trigger"` 的定时触发，不提供客户端测试发送入口。
- 客户端授权次数只作估算，微信发送接口是最终授权边界。
- 当前免费云环境使用每 30 分钟一次的触发器，不改为 5 分钟轮询。
- 测试描述、Git 提交信息和代码注释使用简体中文；日志和异常允许英文。
- 每项实施只暂存该任务文件，保留工作区中其他未提交改动。

## 文件职责

- `cloudfunctions/notice/reminder-policy.js`：通知提醒配置规范化、调度时间和版本变化的纯逻辑。
- `cloudfunctions/notice/index.js`：通知权限、CRUD 和提醒调度字段持久化。
- `cloudfunctions/settings/index.js`：家庭默认提前量的单选校验。
- `cloudfunctions/reminder/core.js`：模板映射、北京时间格式化、Unicode 截断、确定性 ID和错误分类。
- `cloudfunctions/reminder/service.js`：授权状态、任务物化、发送占用、微信调用和结果落库。
- `cloudfunctions/reminder/index.js`：微信上下文鉴权和 action 分发。
- `cloudfunctions/reminder/config.json`：30 分钟定时触发器。
- `miniprogram/utils/subscription.js`：订阅请求编号、微信弹窗结果解析和授权调用。
- `miniprogram/pages/settings/*`：预计授权状态和主动增加一次授权入口。
- `miniprogram/pages/notice-edit/*`：提醒单选、提醒对象和保存时订阅交互。
- `miniprogram/pages/notice-detail/*`：订阅消息落地的只读通知详情页。
- `miniprogram/pages/notice-list/*`：列表进入只读详情，维护操作从详情页进入编辑页。
- `tests/notice-reminder.test.js`：通知调度字段与默认配置测试。
- `tests/reminder-core.test.js`：纯提醒逻辑测试。
- `tests/reminder-service.test.js`：授权池、物化、并发占用和发送结果测试。
- `tests/subscription-client.test.js`：客户端订阅结果解析测试。
- `cloudfunctions/README.md`、`README.md`：部署、集合、索引、安全规则和已实现状态。

---

### Task 1: 通知调度字段和默认提醒单选

**Files:**
- Create: `cloudfunctions/notice/reminder-policy.js`
- Modify: `cloudfunctions/notice/index.js`
- Modify: `cloudfunctions/settings/index.js`
- Modify: `tests/notice-validation.test.js`
- Modify: `tests/settings-security.test.js`
- Test: `tests/notice-reminder.test.js`

**Interfaces:**
- Produces: `normalizeAdvance(value)`，返回 `120`、`1440` 或 `null`。
- Produces: `buildReminderFields(input, currentNotice)`，返回 `remindAdvance`、`scheduledAt`、`reminderVersion`、`reminderState` 和 `isReminded`。
- Produces: `hasReminderConfigChanged(currentNotice, nextConfig)`，只比较时间、提前量、接收关系和启停状态。
- Changes: `settings.publicSettings().reminderDefaultAdvance` 始终是只含一个元素的数组，默认 `[120]`。

- [ ] **Step 1: 编写通知调度和设置单选失败测试**

```javascript
test("通知只接受一个有效提前时间", async () => {
  const fixture = loadNoticeFunction();
  const result = await fixture.main({
    action: "create",
    semester: "2026下",
    title: "家长会",
    category: "activity",
    remindTime: "2026-09-10T12:00:00.000Z",
    remindAdvance: [1440, 120],
    remindTargets: ["father"],
  });
  assert.equal(result.success, false);
  assert.equal(result.message, "每条通知只能选择一个提醒时间");
});

test("提前两小时生成调度时间和首个提醒版本", async () => {
  const fixture = loadNoticeFunction();
  const result = await fixture.main({
    action: "create",
    semester: "2026下",
    title: "家长会",
    category: "activity",
    remindTime: "2026-09-10T12:00:00.000Z",
    remindAdvance: [120],
    remindTargets: ["father"],
  });
  assert.equal(result.success, true);
  assert.equal(fixture.getCreatedNotice().scheduledAt.toISOString(), "2026-09-10T10:00:00.000Z");
  assert.equal(fixture.getCreatedNotice().reminderVersion, 1);
  assert.equal(fixture.getCreatedNotice().reminderState, "scheduled");
});

test("家庭默认提醒只保存一个有效值", async () => {
  const fixture = loadSettingsFunction({ role: "creator", currentSettings: null });
  const result = await fixture.main({
    action: "updatePreferences",
    reminderDefaultAdvance: [1440, 120],
    reminderTargets: ["father"],
  });
  assert.equal(result.success, false);
  assert.equal(result.message, "默认提醒时间只能选择一个");
});
```

- [ ] **Step 2: 运行测试并确认按预期失败**

Run: `node --test tests/notice-validation.test.js tests/notice-reminder.test.js tests/settings-security.test.js`

Expected: FAIL，现有实现允许两个提前量且没有 `scheduledAt`、`reminderVersion`、`reminderState`。

- [ ] **Step 3: 实现通知提醒纯策略**

```javascript
const VALID_ADVANCES = new Set([120, 1440]);

function normalizeAdvance(value) {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const advance = Number(value[0]);
  return Number.isInteger(advance) && VALID_ADVANCES.has(advance) ? advance : null;
}

function sameTargets(left, right) {
  return [...left].sort().join("|") === [...right].sort().join("|");
}

function hasReminderConfigChanged(current, next) {
  const currentTime = current && current.remindTime ? new Date(current.remindTime).getTime() : null;
  const nextTime = next.remindTime ? new Date(next.remindTime).getTime() : null;
  return currentTime !== nextTime
    || normalizeAdvance(current && current.remindAdvance) !== normalizeAdvance(next.remindAdvance)
    || !sameTargets(current && Array.isArray(current.remindTargets) ? current.remindTargets : [], next.remindTargets)
    || Boolean(currentTime) !== Boolean(nextTime);
}

function buildReminderFields(next, current = null) {
  const enabled = next.remindTime instanceof Date;
  const advance = normalizeAdvance(next.remindAdvance);
  if (enabled && advance === null) throw new Error("INVALID_ADVANCE");
  if (enabled && next.remindTargets.length === 0) throw new Error("MISSING_TARGETS");
  const changed = !current || hasReminderConfigChanged(current, next);
  const currentVersion = Number.isInteger(current && current.reminderVersion) ? current.reminderVersion : 0;
  return {
    remindAdvance: advance === null ? [120] : [advance],
    scheduledAt: enabled ? new Date(next.remindTime.getTime() - advance * 60000) : null,
    reminderVersion: changed ? currentVersion + 1 : currentVersion,
    reminderState: enabled ? (changed ? "scheduled" : current.reminderState || "scheduled") : "disabled",
    isReminded: changed ? false : current && current.isReminded === true,
  };
}

module.exports = { normalizeAdvance, hasReminderConfigChanged, buildReminderFields };
```

- [ ] **Step 4: 接入通知 CRUD 和设置校验**

在 `notice.save` 中，新建时传 `null`，更新时传已读取的原通知；把策略错误稳定映射为用户可理解的返回消息：

```javascript
const reminderFields = buildReminderFields(payload.data, updating ? item : null);
Object.assign(payload.data, reminderFields);
```

在 `settings` 中使用相同的业务规则但不跨云函数目录引用：只允许数组长度为 1 且值为 `120` 或 `1440`，默认值改为 `[120]`。输入不符合时返回“默认提醒时间只能选择一个”。

- [ ] **Step 5: 运行相关测试和完整回归**

Run: `node --test tests/notice-validation.test.js tests/notice-reminder.test.js tests/settings-security.test.js`

Expected: PASS，0 失败。

Run: `node --test tests/*.test.js`

Expected: PASS，0 失败。

- [ ] **Step 6: 提交任务变更**

```bash
git add cloudfunctions/notice/reminder-policy.js cloudfunctions/notice/index.js cloudfunctions/settings/index.js tests/notice-validation.test.js tests/notice-reminder.test.js tests/settings-security.test.js
git commit -m "功能：建立通知提醒调度规则"
```

---

### Task 2: 模板映射、幂等键和错误分类核心

**Files:**
- Create: `cloudfunctions/reminder/core.js`
- Test: `tests/reminder-core.test.js`

**Interfaces:**
- Produces: `TODO_TEMPLATE_ID`，值为已确认模板 ID。
- Produces: `createSubscriptionId(openid, templateId)` 和 `createDeliveryId(noticeId, reminderVersion, recipientOpenid, templateId)`。
- Produces: `buildTemplateData(notice)`，返回微信 `data` 字段。
- Produces: `buildSafeTemplateData(notice)`，返回不含用户正文的降级字段。
- Produces: `classifySendError(error)`，返回 `authorization_missing`、`blocked`、`concurrent`、`invalid_payload`、`sensitive`、`temporary` 或 `uncertain`。

- [ ] **Step 1: 编写纯函数失败测试**

```javascript
test("待办模板按确认字段映射并使用北京时间", () => {
  const data = buildTemplateData({
    title: "初一家长会",
    content: "请家长提前十分钟到校并携带纸笔",
    category: "activity",
    remindTime: new Date("2026-09-10T12:30:00.000Z"),
  });
  assert.deepEqual(data, {
    thing1: { value: "初一家长会" },
    time2: { value: "20:30" },
    thing4: { value: "09月10日·请家长提前十分钟到校并携带纸笔" },
    thing15: { value: "活动安排" },
    phrase25: { value: "待处理" },
  });
});

test("同一通知版本和接收人生成相同发送记录ID", () => {
  const first = createDeliveryId("notice-1", 2, "openid-1", TODO_TEMPLATE_ID);
  const second = createDeliveryId("notice-1", 2, "openid-1", TODO_TEMPLATE_ID);
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
});

test("微信未订阅错误分类为授权不足", () => {
  assert.equal(classifySendError({ errCode: 43101 }), "authorization_missing");
});
```

- [ ] **Step 2: 运行测试并确认按预期失败**

Run: `node --test tests/reminder-core.test.js`

Expected: FAIL，`cloudfunctions/reminder/core.js` 尚不存在。

- [ ] **Step 3: 实现纯提醒核心**

使用 Node.js 内置 `crypto`，不引入依赖。文本按 Unicode 码点截断，去除控制字符并压缩空白；`thing` 字段上限 20 个字符，`phrase25` 固定为 3 个汉字：

```javascript
const crypto = require("crypto");

const TODO_TEMPLATE_ID = "5Iy1Jv7aswWNmrRMDXgrcj2BKeywdH6evDst6OomB2c";
const CATEGORY_NAMES = {
  flag_raising: "学校通知",
  exam: "考试通知",
  activity: "活动安排",
  homework: "作业事项",
  other: "其他事项",
};

function hashParts(parts) {
  return crypto.createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

function createSubscriptionId(openid, templateId) {
  return hashParts([openid, templateId]);
}

function createDeliveryId(noticeId, reminderVersion, recipientOpenid, templateId) {
  return hashParts([noticeId, String(reminderVersion), recipientOpenid, templateId]);
}
```

`buildTemplateData` 固定输出 `thing1`、`time2`、`thing4`、`thing15`、`phrase25`；日期和时间用 `getUTC*` 读取加 8 小时后的日期，避免依赖云函数机器时区。`buildSafeTemplateData` 使用“家庭待办”“请进入小程序查看详情”等固定内容。

错误码映射：`43101 → authorization_missing`、`43107 → blocked`、`43108 → concurrent`、`47003 → invalid_payload`、`45168 → sensitive`；能够确定微信未处理请求的服务端错误为 `temporary`，没有响应或结果未知为 `uncertain`。

- [ ] **Step 4: 运行核心测试**

Run: `node --test tests/reminder-core.test.js`

Expected: PASS，覆盖 Unicode 截断、非法日期、安全文案和所有错误分类。

- [ ] **Step 5: 提交任务变更**

```bash
git add cloudfunctions/reminder/core.js tests/reminder-core.test.js
git commit -m "功能：实现订阅提醒核心规则"
```

---

### Task 3: 当前用户订阅状态和授权登记

**Files:**
- Create: `cloudfunctions/reminder/service.js`
- Modify: `cloudfunctions/reminder/index.js`
- Modify: `tests/cloud-authentication.test.js`
- Test: `tests/reminder-service.test.js`

**Interfaces:**
- Produces: `createReminderService({ database, sendSubscribeMessage, now, miniprogramState })`。
- Produces: `service.getStatus(user)`，返回 `{ enabled, templateId, estimatedAvailableCount, pendingCount, blockedReason }`。
- Produces: `service.recordSubscription(user, input)`，输入只读取 `templateId`、`decision` 和 `requestId`。
- Produces: `service.run()`，供 Task 4 实现调度主体。
- Changes: `reminder.main(event)` 对客户端只开放 `getStatus` 和 `recordSubscription`。

- [ ] **Step 1: 编写鉴权和授权登记失败测试**

```javascript
test("客户端不能伪造定时发送", async () => {
  const fixture = loadReminderFunction({ openid: "openid-1", source: "wx_client" });
  const result = await fixture.main({ action: "run" });
  assert.equal(result.success, false);
  assert.equal(result.message, "不支持的操作");
});

test("重复请求编号只登记一次授权", async () => {
  const service = createReminderService(createServiceDependencies());
  const input = {
    templateId: TODO_TEMPLATE_ID,
    decision: "accept",
    requestId: "request_20260908_0001",
  };
  await service.recordSubscription(testUser, input);
  await service.recordSubscription(testUser, input);
  assert.equal(getSubscription().estimatedAvailableCount, 1);
  assert.equal(getSubscription().dailyRecordCount, 1);
});

test("授权登记忽略客户端身份和次数", async () => {
  const service = createReminderService(createServiceDependencies());
  await service.recordSubscription(testUser, {
    templateId: TODO_TEMPLATE_ID,
    decision: "accept",
    requestId: "request_20260908_0002",
    openid: "forged-openid",
    familyId: "forged-family",
    estimatedAvailableCount: 50,
  });
  assert.equal(getSubscription().openid, testUser.openid);
  assert.equal(getSubscription().estimatedAvailableCount, 1);
});
```

- [ ] **Step 2: 运行测试并确认按预期失败**

Run: `node --test tests/cloud-authentication.test.js tests/reminder-service.test.js`

Expected: FAIL，提醒云函数仍为占位，且没有授权事务逻辑。

- [ ] **Step 3: 实现服务构造器和授权事务**

`recordSubscription` 严格校验：

```javascript
const VALID_DECISIONS = new Set(["accept", "reject", "ban", "filter"]);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

function validateSubscriptionInput(input) {
  if (input.templateId !== TODO_TEMPLATE_ID) throw new Error("INVALID_TEMPLATE");
  if (!VALID_DECISIONS.has(input.decision)) throw new Error("INVALID_DECISION");
  if (!REQUEST_ID_PATTERN.test(String(input.requestId || ""))) throw new Error("INVALID_REQUEST_ID");
}
```

事务以 `createSubscriptionId(user.openid, TODO_TEMPLATE_ID)` 读取确定性文档。相同 `requestId` 直接返回当前公开状态；北京时间日期变化时把 `dailyRecordCount` 归零；每日最多登记 20 次，`estimatedAvailableCount` 最大 50；仅 `accept` 增加 1，其他结果只更新 `lastDecision`。

`getStatus` 只返回当前用户的公开字段。`miniprogramState` 不是 `developer`、`trial`、`formal` 时返回 `enabled: false` 和 `blockedReason: "CONFIGURATION"`；不得返回订阅文档 ID或 OpenID。

- [ ] **Step 4: 实现入口鉴权和稳定响应**

```javascript
exports.main = async (event = {}) => {
  const context = cloud.getWXContext();
  try {
    if (context.SOURCE === "wx_trigger") return success(await service.run());
    const user = await requireUser(context.OPENID);
    if (event.action === "getStatus") return success(await service.getStatus(user));
    if (event.action === "recordSubscription") return success(await service.recordSubscription(user, event));
    return failure("不支持的操作");
  } catch (error) {
    console.error("Reminder action failed", { action: event.action, code: error.code, message: error.message });
    return mapPublicFailure(error);
  }
};
```

把 `reminder` 加入“缺少 OpenID 时不得访问数据库”和“拒绝未知用户角色”的现有参数化测试。

- [ ] **Step 5: 运行授权和鉴权测试**

Run: `node --test tests/cloud-authentication.test.js tests/reminder-service.test.js`

Expected: PASS，0 失败。

- [ ] **Step 6: 提交任务变更**

```bash
git add cloudfunctions/reminder/service.js cloudfunctions/reminder/index.js tests/cloud-authentication.test.js tests/reminder-service.test.js
git commit -m "功能：实现微信提醒授权登记"
```

---

### Task 4: 到期任务物化、并发占用和微信发送

**Files:**
- Modify: `cloudfunctions/reminder/service.js`
- Modify: `cloudfunctions/reminder/index.js`
- Create: `cloudfunctions/reminder/config.json`
- Modify: `tests/reminder-service.test.js`

**Interfaces:**
- Completes: `service.run()`，返回 `{ scannedNotices, createdDeliveries, processedDeliveries, sent, waiting, failed, expired }`。
- Produces: `materializeNotice(notice)`，为当前家庭关系匹配的每位成员创建唯一发送记录。
- Produces: `claimDelivery(deliveryId)`，在事务中占用预计次数并锁定发送记录。
- Produces: `completeDelivery(claim, outcome)`，持久化成功、恢复、重试、失败或不确定状态。

- [ ] **Step 1: 编写物化、防重和发送结果失败测试**

```javascript
test("重复扫描只物化一条接收人任务", async () => {
  const fixture = createSchedulerFixture({
    notice: scheduledNotice,
    users: [fatherUser],
  });
  await fixture.service.run();
  await fixture.service.run();
  assert.equal(fixture.getDeliveries().length, 1);
});

test("没有预计授权时保持等待且不调用微信", async () => {
  const fixture = createSchedulerFixture({
    delivery: waitingDelivery,
    estimatedAvailableCount: 0,
  });
  await fixture.service.run();
  assert.equal(fixture.getSendCalls().length, 0);
  assert.equal(fixture.getDelivery().status, "waiting_subscription");
});

test("微信发送成功后完成任务且只扣减一次", async () => {
  const fixture = createSchedulerFixture({
    delivery: waitingDelivery,
    estimatedAvailableCount: 1,
    sendResult: { errCode: 0, errMsg: "openapi.subscribeMessage.send:ok" },
  });
  await fixture.service.run();
  assert.equal(fixture.getDelivery().status, "sent");
  assert.equal(fixture.getSubscription().estimatedAvailableCount, 0);
  assert.equal(fixture.getSendCalls().length, 1);
});

test("结果未知时不自动重发", async () => {
  const fixture = createSchedulerFixture({
    delivery: waitingDelivery,
    estimatedAvailableCount: 1,
    sendError: new Error("socket closed"),
  });
  await fixture.service.run();
  await fixture.service.run();
  assert.equal(fixture.getDelivery().status, "uncertain");
  assert.equal(fixture.getSendCalls().length, 1);
});
```

- [ ] **Step 2: 运行测试并确认按预期失败**

Run: `node --test tests/reminder-service.test.js`

Expected: FAIL，`run` 尚未实现物化和发送。

- [ ] **Step 3: 实现有界扫描和任务物化**

每次最多扫描 20 条到期通知、处理 50 条发送记录。查询必须命中索引：

```javascript
const dueNotices = await database.collection("notices")
  .where({ reminderState: "scheduled", scheduledAt: command.lte(now()) })
  .orderBy("scheduledAt", "asc")
  .limit(20)
  .get();
```

按 `familyId` 查询最多 50 位有效角色成员，仅保留 `notice.remindTargets.includes(user.relation)` 的接收人。发送记录 ID 使用 `createDeliveryId`；事务中存在同 ID 时不覆盖。物化完成后把通知更新为 `materialized`。通知不存在、已删除或版本变化时，发送记录转为 `canceled`。

- [ ] **Step 4: 实现事务占用和串行发送**

事务同时确认：任务状态为 `waiting_subscription` 或已到期的 `retry`、未超过 `deadlineAt`、锁未被占用、订阅预计次数大于 0。满足后：

```javascript
await transaction.collection("message_subscriptions").doc(subscriptionId).update({
  data: { estimatedAvailableCount: currentCount - 1, updatedAt: currentTime },
});
await transaction.collection("reminder_deliveries").doc(deliveryId).update({
  data: {
    status: "sending",
    attemptCount: delivery.attemptCount + 1,
    lockExpiresAt: new Date(currentTime.getTime() + 10 * 60 * 1000),
    updatedAt: currentTime,
  },
});
```

按 `recipientOpenid` 分组后组内串行调用：

```javascript
await sendSubscribeMessage({
  touser: delivery.recipientOpenid,
  templateId: TODO_TEMPLATE_ID,
  page: `pages/notice-detail/notice-detail?id=${delivery.noticeId}`,
  miniprogramState,
  lang: "zh_CN",
  data: buildTemplateData(notice),
});
```

- [ ] **Step 5: 实现错误恢复和通知汇总状态**

- `43101`：预计次数置 0，任务回到 `waiting_subscription`。
- `43107`、`47003`：任务为 `failed`，记录错误码且不自动重试。
- `43108`：恢复一次预计次数，任务为 `retry`，`nextAttemptAt` 延后 30 分钟。
- `45168`：同一次占用内改用 `buildSafeTemplateData` 重试一次；仍失败则 `failed`。
- 明确临时错误：恢复预计次数，最多 3 次，采用 30、60、120 分钟退避且不得超过 `deadlineAt`。
- 响应未知或超时：任务为 `uncertain`，不恢复、不重试。
- 当前时间大于等于 `deadlineAt`：任务为 `expired`，不调用微信。
- 当前版本全部目标发送记录为 `sent`：通知更新为 `reminderState: "completed"`、`isReminded: true`。

错误摘要先去除换行和类似 OpenID 的长标识，再截断至 160 个字符。

- [ ] **Step 6: 增加 30 分钟定时触发配置**

```json
{
  "triggers": [
    {
      "name": "reminderTimer",
      "type": "timer",
      "config": "0 */30 * * * * *"
    }
  ]
}
```

- [ ] **Step 7: 运行调度测试和完整回归**

Run: `node --test tests/reminder-core.test.js tests/reminder-service.test.js`

Expected: PASS，覆盖重复触发、竞争占用、授权不足、成功、全部错误分类、状态不确定和过期。

Run: `node --test tests/*.test.js`

Expected: PASS，0 失败。

- [ ] **Step 8: 提交任务变更**

```bash
git add cloudfunctions/reminder/service.js cloudfunctions/reminder/index.js cloudfunctions/reminder/config.json tests/reminder-service.test.js
git commit -m "功能：实现通知自动提醒调度"
```

---

### Task 5: 设置页订阅入口

**Files:**
- Create: `miniprogram/utils/subscription.js`
- Modify: `miniprogram/pages/settings/settings.js`
- Modify: `miniprogram/pages/settings/settings.wxml`
- Modify: `miniprogram/pages/settings/settings.wxss`
- Test: `tests/subscription-client.test.js`

**Interfaces:**
- Produces: `createRequestId(now, randomValue)`，返回 16 至 64 位安全请求编号。
- Produces: `getDecision(result, templateId)`，只返回 `accept`、`reject`、`ban`、`filter`。
- Produces: `requestReminderSubscription(templateId)`，返回 `{ templateId, decision, requestId }`。
- Changes: 设置页通过 `reminder.getStatus` 展示 `estimatedAvailableCount` 和 `pendingCount`。

- [ ] **Step 1: 编写客户端解析失败测试**

```javascript
test("订阅结果只读取目标模板", () => {
  const templateId = "template-id";
  assert.equal(getDecision({ [templateId]: "accept", errMsg: "ok" }, templateId), "accept");
  assert.throws(() => getDecision({ [templateId]: "unexpected" }, templateId), /Invalid subscription decision/);
});

test("订阅请求编号满足服务端格式", () => {
  const requestId = createRequestId(1788796800000, 0.123456789);
  assert.match(requestId, /^[A-Za-z0-9_-]{16,64}$/);
});
```

- [ ] **Step 2: 运行测试并确认按预期失败**

Run: `node --test tests/subscription-client.test.js`

Expected: FAIL，客户端订阅工具尚不存在。

- [ ] **Step 3: 实现微信订阅工具**

```javascript
const VALID_DECISIONS = new Set(["accept", "reject", "ban", "filter"]);

function getDecision(result, templateId) {
  const decision = result && result[templateId];
  if (!VALID_DECISIONS.has(decision)) throw new Error("Invalid subscription decision");
  return decision;
}

async function requestReminderSubscription(templateId) {
  const requestId = createRequestId(Date.now(), Math.random());
  const result = await wx.requestSubscribeMessage({ tmplIds: [templateId] });
  return { templateId, decision: getDecision(result, templateId), requestId };
}
```

不得在工具中硬编码 AppSecret、OpenID 或家庭 ID。

- [ ] **Step 4: 设置页接入状态卡片和主动授权**

设置页 `load` 并行调用 `settings.get` 与 `reminder.getStatus`。把默认提前量的 `checkbox-group` 改为 `radio-group`：

```xml
<radio-group bindchange="onAdvanceChange">
  <label class="check"><radio value="1440" checked="{{advanceDay}}" color="#4A90D9" />提前1天</label>
  <label class="check"><radio value="120" checked="{{advanceHours}}" color="#4A90D9" />提前2小时</label>
</radio-group>
```

状态卡片显示“预计可用 {{reminderStatus.estimatedAvailableCount}} 次”和“增加 1 次提醒”。`addReminderSubscription` 必须直接由 `bindtap` 触发 `wx.requestSubscribeMessage`，接受后调用：

```javascript
const subscription = await requestReminderSubscription(this.data.reminderStatus.templateId);
await callFunction("reminder", "recordSubscription", subscription);
await this.load();
```

`reject`、`ban`、`filter` 使用不同中文提示；接口失败保留错误上下文并调用 `showError`，不得增加本地次数。

- [ ] **Step 5: 运行客户端测试和静态校验**

Run: `node --test tests/subscription-client.test.js`

Expected: PASS，0 失败。

Run: `node scripts/validate-project.js`

Expected: PASS，WXML 处理器存在且没有 JSON、JavaScript 或标签错误。

- [ ] **Step 6: 提交任务变更**

```bash
git add miniprogram/utils/subscription.js miniprogram/pages/settings/settings.js miniprogram/pages/settings/settings.wxml miniprogram/pages/settings/settings.wxss tests/subscription-client.test.js
git commit -m "功能：增加微信提醒订阅入口"
```

---

### Task 6: 通知编辑订阅交互和只读详情页

**Files:**
- Modify: `miniprogram/app.json`
- Modify: `miniprogram/pages/notice-edit/notice-edit.js`
- Modify: `miniprogram/pages/notice-edit/notice-edit.wxml`
- Modify: `miniprogram/pages/notice-edit/notice-edit.wxss`
- Modify: `miniprogram/pages/notice-list/notice-list.js`
- Modify: `miniprogram/pages/notice-list/notice-list.wxml`
- Create: `miniprogram/pages/notice-detail/notice-detail.js`
- Create: `miniprogram/pages/notice-detail/notice-detail.json`
- Create: `miniprogram/pages/notice-detail/notice-detail.wxml`
- Create: `miniprogram/pages/notice-detail/notice-detail.wxss`
- Modify: `tests/subscription-client.test.js`

**Interfaces:**
- Consumes: `requestReminderSubscription(templateId)` 和 `reminder.getStatus`。
- Produces: `pages/notice-detail/notice-detail?id=<noticeId>`。
- Changes: 通知列表卡片始终进入详情页，详情页按 `canPerform(role, "manageNotice")` 决定是否显示编辑入口。

- [ ] **Step 1: 扩展客户端状态判断失败测试**

为订阅工具增加纯函数 `shouldRequestSubscription({ reminderEnabled, currentRelation, remindTargets, estimatedAvailableCount })`：

```javascript
test("当前关系在提醒对象中且没有预计次数时需要订阅", () => {
  assert.equal(shouldRequestSubscription({
    reminderEnabled: true,
    currentRelation: "father",
    remindTargets: ["father", "mother"],
    estimatedAvailableCount: 0,
  }), true);
});

test("其他接收人的提醒不能由创建者代订阅", () => {
  assert.equal(shouldRequestSubscription({
    reminderEnabled: true,
    currentRelation: "father",
    remindTargets: ["mother"],
    estimatedAvailableCount: 0,
  }), false);
});
```

- [ ] **Step 2: 运行测试并确认按预期失败**

Run: `node --test tests/subscription-client.test.js`

Expected: FAIL，`shouldRequestSubscription` 尚不存在。

- [ ] **Step 3: 实现通知编辑状态和单选交互**

- `onLoad` 获取家庭设置、当前用户关系和提醒状态；新建通知使用 `[120]` 与家庭默认提醒对象，编辑通知使用已保存值。
- `onAdvanceChange` 把单个 radio 值保存为 `[Number(event.detail.value)]`。
- 增加全部 `RELATIONS` 的提醒对象选择，`checkbox-group` 保存去重关系值。
- 开启提醒且没有接收对象时阻止保存。
- `save` 的首次动作依据已加载状态直接调用 `requestReminderSubscription`，不得在调用微信弹窗前执行新的异步请求。
- 授权拒绝或弹窗关闭不阻止通知保存；授权登记失败同样保存，但显示“通知已保存，微信提醒授权记录失败，请到设置页重试”。
- 已有预计次数时不重复弹窗。

主按钮文案：

```xml
{{needsSubscription ? '保存并订阅提醒' : '保存通知'}}
```

- [ ] **Step 4: 实现只读通知详情和列表导航**

在 `app.json` 注册 `pages/notice-detail/notice-detail`。详情页校验 `id` 为 1 至 64 个字母、数字、下划线或连字符；非法 ID提示并返回。加载后使用 `notice.get`，只展示公开字段：

```javascript
this.setData({
  item: {
    ...item,
    categoryName: category.label,
    remindTimeText: formatDateTime(item.remindTime),
    advanceText: item.remindAdvance[0] === 1440 ? "提前1天" : "提前2小时",
    targetText: item.remindTargets.map((value) => RELATIONS[value]).filter(Boolean).join("、"),
  },
  canEdit: canPerform(session.user.role, "manageNotice"),
});
```

图片使用 `wx.previewImage`。列表卡片的 `bindtap` 改为 `view`，孩子账号也可进入详情；详情页编辑按钮才执行权限判断并导航到 `notice-edit`。

- [ ] **Step 5: 运行前端测试、完整回归和静态校验**

Run: `node --test tests/subscription-client.test.js`

Expected: PASS，0 失败。

Run: `node --test tests/*.test.js`

Expected: PASS，0 失败。

Run: `node scripts/validate-project.js`

Expected: PASS，页面数量增加 1，云函数数量保持 9。

- [ ] **Step 6: 提交任务变更**

```bash
git add miniprogram/app.json miniprogram/pages/notice-edit miniprogram/pages/notice-list miniprogram/pages/notice-detail miniprogram/utils/subscription.js tests/subscription-client.test.js
git commit -m "功能：完成通知提醒订阅交互"
```

---

### Task 7: 部署文档、云环境和真机验收

**Files:**
- Modify: `cloudfunctions/README.md`
- Modify: `README.md`
- Modify: `scripts/validate-project.js`

**Interfaces:**
- Documents: 新增集合、索引、权限、环境变量、触发器、回退方式和真机验收步骤。
- Verifies: 16 个页面、9 个云函数、提醒触发器配置、模板 ID一致性和无敏感配置。

- [ ] **Step 1: 扩展静态验证要求**

在现有脚本中增加以下确定性检查：

```javascript
const reminderConfig = JSON.parse(fs.readFileSync(path.join(cloudRoot, "reminder/config.json"), "utf8"));
if (reminderConfig.triggers?.[0]?.config !== "0 */30 * * * * *") {
  errors.push("提醒定时触发器不是每30分钟执行一次");
}
if (!sourceText.includes("5Iy1Jv7aswWNmrRMDXgrcj2BKeywdH6evDst6OomB2c")) {
  errors.push("待办事项提醒模板ID缺失");
}
if (sourceText.includes("5ly1Jv7aswWNmrRMDXgrcj2BKeywdH6evDst6OomB2c")) {
  errors.push("检测到大小写错误的待办事项提醒模板ID");
}
```

- [ ] **Step 2: 更新部署文档**

文档明确新增集合：

```text
message_subscriptions
reminder_deliveries
```

两者安全规则均设为客户端不可读、不可写。新增索引：

```text
notices:               reminderState ASC, scheduledAt ASC
reminder_deliveries:  status ASC, nextAttemptAt ASC
reminder_deliveries:  noticeId ASC, reminderVersion ASC
```

记录 `MINIPROGRAM_STATE=developer`、30 分钟频率、免费资源观察方法和停用触发器的回退流程。更新根 README，删除“订阅消息不会实际发送”的过期描述。

- [ ] **Step 3: 运行发布前本地验证**

Run: `node --test tests/*.test.js`

Expected: 全部 PASS，0 失败。

Run: `node scripts/validate-project.js`

Expected: `项目静态校验通过`，16 个页面、9 个云函数。

Run: `git diff --check`

Expected: 无输出，退出码 0。

- [ ] **Step 4: 在免费云环境创建资源并配置权限**

目标环境必须核对为 `cloud1-d3g2hleood2cae7e7`。在微信开发者工具云开发控制台：

1. 创建 `message_subscriptions` 和 `reminder_deliveries`。
2. 两个集合的客户端安全规则设为拒绝读写，保存后重新打开核对。
3. 创建三项复合索引并等待状态变为可用。
4. 在 `reminder` 云函数配置 `MINIPROGRAM_STATE=developer`。

不得点击腾讯云页面的“免费开发”入口，不得创建第二套环境。

- [ ] **Step 5: 部署并核对云函数**

在微信开发者工具分别右键 `notice` 和 `reminder`，选择“上传并部署：云端安装依赖（不上传 node_modules）”。确认两者状态为 `Active`，然后核对 `reminderTimer` 已安装且 Cron 为：

```text
0 */30 * * * * *
```

- [ ] **Step 6: 执行开发者工具和真机验收**

1. 重新编译，确认问题面板为 0。
2. 真机进入设置页，点击“增加 1 次提醒”并接受，确认预计次数增加 1。
3. 创建当前用户属于提醒对象、调度时间落在下一触发窗口的测试通知。
4. 在 30 分钟调度窗口内确认只收到一条消息。
5. 核对 `thing1`、`time2`、`thing4`、`thing15`、`phrase25` 内容和北京时间。
6. 点击消息，确认进入正确的只读通知详情页。
7. 再验证拒绝授权仍保存通知、重复触发不重复发送、过期通知不补发。

真机等待期间每次只读检查一次云函数日志和两类记录状态，不手工调用 `run`。

- [ ] **Step 7: 提交文档和校验变更**

```bash
git add cloudfunctions/README.md README.md scripts/validate-project.js
git commit -m "文档：补充订阅提醒部署与验收说明"
```

- [ ] **Step 8: 发布后核验和回退标准**

- 记录本次部署时间、函数状态、触发器状态和真机送达结果。
- 观察免费资源点；异常增长时把触发器改为每小时一次 `0 0 * * * * *`。
- 出现模板字段错误或误发风险时先停用 `reminderTimer`，保留审计集合，不删除历史记录。
- 通知提醒完成真机验收后，重新盘点剩余基础功能；全部基础功能完成后再与用户研讨 PRD 扩展能力。
