const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createEditableNoticeDrafts,
  createNoticeDraftTransfer,
  createNoticeBatchPayload,
  mergeNoticeDrafts,
} = require("../miniprogram/utils/notice-ai-import");

const TEST_JOB_ID = "01010101010101010101010101010101";

test("通知 AI 草稿规范化分类、不确定字段和建议时间", () => {
  const drafts = createEditableNoticeDrafts([{
    semester: "2026下",
    title: "家长会",
    source: "班主任",
    category: "activity",
    content: "请提前十分钟到场",
    suggestedRemindTime: "2026-09-21T11:00:00.000Z",
    uncertainFields: ["eventTime", "createdBy", "eventTime"],
  }], "2026下", TEST_JOB_ID);

  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].requestId, `${TEST_JOB_ID}_0`);
  assert.equal(drafts[0].categoryLabel, "活动");
  assert.equal(drafts[0].suggestedRemindTime, "2026-09-21T11:00:00.000Z");
  assert.equal(drafts[0].eventTimeUncertain, true);
  assert.deepEqual(drafts[0].uncertainFields, ["eventTime"]);
  assert.equal(drafts[0].saved, false);
});

test("通知 AI 草稿拒绝非法任务编号并安全归一非法分类和时间", () => {
  assert.throws(() => createEditableNoticeDrafts([{ title: "通知" }], "2026下", "short"), /任务编号/);
  const [draft] = createEditableNoticeDrafts([{
    title: "通知",
    category: "malicious",
    suggestedRemindTime: "not-a-date",
  }], "2026下", TEST_JOB_ID);
  assert.equal(draft.category, "other");
  assert.equal(draft.categoryLabel, "其他");
  assert.equal(draft.suggestedRemindTime, "");
});

test("通知草稿传入编辑页时只保留通知白名单字段", () => {
  const [draft] = createEditableNoticeDrafts([{
    semester: "2026下",
    title: "考试安排",
    source: "年级组",
    category: "exam",
    content: "周三考试",
    requirements: [],
    suggestedRemindTime: "2026-09-23T00:00:00.000Z",
    familyId: "forged-family",
  }], "2026下", TEST_JOB_ID);
  const transfer = createNoticeDraftTransfer(draft);

  assert.deepEqual(transfer, {
    requestId: `${TEST_JOB_ID}_0`,
    semester: "2026下",
    title: "考试安排",
    source: "年级组",
    category: "exam",
    content: "周三考试",
    requirements: [],
    suggestedRemindTime: "2026-09-23T00:00:00.000Z",
  });
  assert.equal(transfer.familyId, undefined);
  assert.throws(() => createNoticeDraftTransfer({ ...draft, title: "" }), /标题/);
});

test("通知正文中的多项要求可以合并为一条可编辑草稿", () => {
  const drafts = createEditableNoticeDrafts([
    { semester: "2026下", title: "1. 周五穿校服", source: "班主任", category: "activity", content: "早上七点四十分到校", uncertainFields: [] },
    { semester: "2026下", title: "2. 携带资料", source: "班主任", category: "activity", content: "带齐报名表和黑色签字笔", uncertainFields: [] },
  ], "2026下", TEST_JOB_ID);

  const merged = mergeNoticeDrafts(drafts, TEST_JOB_ID);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].title, "学校通知");
  assert.equal(merged[0].source, "班主任");
  assert.equal(merged[0].category, "activity");
  assert.match(merged[0].content, /1\. 周五穿校服/);
  assert.match(merged[0].content, /2\. 携带资料/);
  assert.equal(merged[0].titleUncertain, true);
});

test("合并通知正文超过存储上限时提示用户核对内容", () => {
  const drafts = createEditableNoticeDrafts([
    { semester: "2026下", title: "第一项", category: "other", content: "甲".repeat(2000), uncertainFields: [] },
    { semester: "2026下", title: "第二项", category: "other", content: "乙".repeat(2000), uncertainFields: [] },
  ], "2026下", TEST_JOB_ID);

  const [merged] = mergeNoticeDrafts(drafts, TEST_JOB_ID);

  assert.equal(merged.content.length, 3000);
  assert.equal(merged.contentUncertain, true);
  assert.ok(merged.uncertainFields.includes("content"));
});

test("通知批量保存载荷只包含白名单字段并带幂等编号", () => {
  const drafts = createEditableNoticeDrafts([
    { semester: "2026下", title: "家长会", source: "班主任", category: "activity", content: "周五召开", uncertainFields: [] },
    { semester: "2026下", title: "体检", source: "校医室", category: "other", content: "携带体检表", uncertainFields: [] },
  ], "2026下", TEST_JOB_ID);
  drafts[1].saved = true;
  drafts[0].familyId = "forged-family";

  const payloads = createNoticeBatchPayload(drafts);

  assert.equal(payloads.length, 1);
  assert.deepEqual(payloads[0], {
    semester: "2026下",
    title: "家长会",
    source: "班主任",
    category: "activity",
    content: "周五召开",
    requirements: [],
    images: [],
    remindTime: null,
    remindAdvance: [120],
    remindTargets: [],
    clientRequestId: `${TEST_JOB_ID}_0`,
  });
  assert.equal(payloads[0].familyId, undefined);
});
