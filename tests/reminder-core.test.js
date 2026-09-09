const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TODO_TEMPLATE_ID,
  createSubscriptionId,
  createDeliveryId,
  buildTemplateData,
  buildSafeTemplateData,
  classifySendError,
} = require("../cloudfunctions/reminder/core");

test("待办模板使用确认的模板 ID", () => {
  assert.equal(TODO_TEMPLATE_ID, "5Iy1Jv7aswWNmrRMDXgrcj2BKeywdH6evDst6OomB2c");
});

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
    thing4: { value: "09月10日·请家长提前十分钟到校并携带" },
    thing15: { value: "活动安排" },
    phrase25: { value: "待处理" },
  });
});

test("模板文本移除控制字符并压缩空白", () => {
  const data = buildTemplateData({
    title: "  初一\u0000  家长会  ",
    content: "请家长\u0000　提前  十分钟到校",
    category: "other",
    remindTime: new Date("2026-09-10T12:30:00.000Z"),
  });

  assert.equal(data.thing1.value, "初一 家长会");
  assert.equal(data.thing4.value, "09月10日·请家长 提前 十分钟到校");
});

test("thing 字段按 20 个 Unicode 码点截断", () => {
  const data = buildTemplateData({
    title: "1234567890123456789😀X",
    content: "内容",
    category: "other",
    remindTime: new Date("2026-09-10T12:30:00.000Z"),
  });

  assert.equal(data.thing1.value, "1234567890123456789😀");
  assert.equal(Array.from(data.thing1.value).length, 20);
});

test("非法提醒时间明确失败", () => {
  assert.throws(() => buildTemplateData({
    title: "家长会",
    content: "请参加",
    category: "activity",
    remindTime: new Date("invalid"),
  }), /INVALID_REMIND_TIME/);
});

test("安全模板不包含通知正文", () => {
  const data = buildSafeTemplateData({
    title: "这是通知标题",
    content: "这是不应发送的用户正文",
    category: "exam",
    remindTime: new Date("2026-09-10T12:30:00.000Z"),
  });

  assert.deepEqual(data, {
    thing1: { value: "家庭待办" },
    time2: { value: "20:30" },
    thing4: { value: "09月10日·请进入小程序查看详情" },
    thing15: { value: "其他事项" },
    phrase25: { value: "待处理" },
  });
});

test("同一通知版本和接收人生成相同发送记录 ID", () => {
  const first = createDeliveryId("notice-1", 2, "openid-1", TODO_TEMPLATE_ID);
  const second = createDeliveryId("notice-1", 2, "openid-1", TODO_TEMPLATE_ID);

  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
});

test("发送记录 ID 区分通知、版本、接收人和模板", () => {
  const base = createDeliveryId("notice-1", 2, "openid-1", TODO_TEMPLATE_ID);

  assert.notEqual(createDeliveryId("notice-2", 2, "openid-1", TODO_TEMPLATE_ID), base);
  assert.notEqual(createDeliveryId("notice-1", 3, "openid-1", TODO_TEMPLATE_ID), base);
  assert.notEqual(createDeliveryId("notice-1", 2, "openid-2", TODO_TEMPLATE_ID), base);
  assert.notEqual(createDeliveryId("notice-1", 2, "openid-1", "another-template"), base);
});

test("同一用户和模板生成稳定订阅记录 ID", () => {
  const first = createSubscriptionId("openid-1", TODO_TEMPLATE_ID);
  const second = createSubscriptionId("openid-1", TODO_TEMPLATE_ID);

  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
});

test("微信未订阅错误分类为授权不足", () => {
  assert.equal(classifySendError({ errCode: 43101 }), "authorization_missing");
});

test("明确微信错误码分类为终态结果", () => {
  assert.equal(classifySendError({ errCode: 43107 }), "blocked");
  assert.equal(classifySendError({ errCode: 43108 }), "concurrent");
  assert.equal(classifySendError({ errCode: 47003 }), "invalid_payload");
  assert.equal(classifySendError({ errCode: 45168 }), "sensitive");
});

test("明确服务繁忙分类为临时错误", () => {
  assert.equal(classifySendError({ errCode: -1 }), "temporary");
  assert.equal(classifySendError(new Error("system busy")), "temporary");
});

test("未知发送结果分类为不确定", () => {
  assert.equal(classifySendError(), "uncertain");
  assert.equal(classifySendError(new Error("network disconnected")), "uncertain");
  assert.equal(classifySendError({ errCode: 99999 }), "uncertain");
  assert.equal(classifySendError({ code: "ETIMEDOUT" }), "uncertain");
});
