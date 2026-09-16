const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const testUser = { _id: "user-1", openid: "openid-1", familyId: "family-1", role: "creator" };
const otherUser = { _id: "user-2", openid: "openid-2", familyId: "family-2", role: "member" };
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(12)]);

function loadAiModule(options = {}) {
  const sourcePath = path.join(__dirname, "../cloudfunctions/ai/index.js");
  const moduleValue = { exports: {} };
  const context = vm.createContext({
    Buffer,
    console: options.console || { info() {}, error() {} },
    process: { env: options.environment || {} },
    module: moduleValue,
    exports: moduleValue.exports,
    require(request) {
      if (request === "wx-server-sdk") return {
        DYNAMIC_CURRENT_ENV: "test",
        init() {},
        database: () => options.database || { collection() { throw new Error("数据库不应被访问"); } },
        getWXContext: () => options.context || {},
      };
      if (request === "@cloudbase/node-sdk") return {
        SYMBOL_CURRENT_ENV: Symbol.for("TENCENTCLOUD_RUNENV"),
        init: (input) => {
          if (options.onCloudbaseInit) options.onCloudbaseInit(input);
          return options.cloudbaseApp || {};
        },
      };
      if (request === "node:crypto") return require("node:crypto");
      if (request === "./core") return require("../cloudfunctions/ai/core");
      if (request === "./model-client") return require("../cloudfunctions/ai/model-client");
      throw new Error(`测试未实现依赖：${request}`);
    },
  });
  vm.runInContext(fs.readFileSync(sourcePath, "utf8"), context, { filename: sourcePath });
  return moduleValue.exports;
}

function createFixture(options = {}) {
  let currentTime = new Date("2026-09-13T15:59:59.000Z");
  let documents = new Map();
  let transactionQueue = Promise.resolve();
  let randomCounter = 1;
  const users = options.users || [testUser, otherUser];
  const downloads = new Map();
  const deleted = [];
  const metadataCalls = [];
  const logs = [];

  function documentMissing() {
    const error = new Error("document.get:fail document does not exist");
    error.code = "DOCUMENT_NOT_FOUND";
    return error;
  }

  function collection(name, storage) {
    if (name === "users") return {
      where(query) {
        return { limit() { return { async get() {
          return { data: users.filter((user) => user.openid === query.openid).map((user) => structuredClone(user)) };
        } }; } };
      },
    };
    if (name === "families") return { doc(id) { return { async get() {
      if (id !== "family-1" && id !== "family-2") throw documentMissing();
      return { data: { _id: id, currentSemester: "2026下", educationStage: "junior_high", grade: "1" } };
    } }; } };
    if (name === "subjects") return {
      where(query) { return { limit() { return { async get() {
        return query.familyId === "family-1"
          ? { data: [{ _id: "subjects-1", familyId: "family-1", subjects: options.subjects || ["语文", "数学"] }] }
          : { data: [] };
      } }; } }; },
    };
    if (name === "ai_import_jobs") return { doc(id) { return {
      async get() {
        if (!storage.has(id)) throw documentMissing();
        return { data: structuredClone(storage.get(id)) };
      },
      async set({ data }) { storage.set(id, structuredClone(data)); },
      async update({ data }) {
        if (!storage.has(id)) throw documentMissing();
        storage.set(id, { ...structuredClone(storage.get(id)), ...structuredClone(data) });
      },
    }; } };
    throw new Error(`测试未实现集合：${name}`);
  }

  const database = {
    collection(name) { return collection(name, documents); },
    async runTransaction(callback) {
      const result = transactionQueue.then(async () => {
        const staged = structuredClone(documents);
        const value = await callback({ collection: (name) => collection(name, staged) });
        documents = staged;
        return value;
      });
      transactionQueue = result.catch(() => {});
      return result;
    },
  };

  const cloudbaseApp = {
    async getUploadMetadata({ cloudPath }) {
      metadataCalls.push(cloudPath);
      const fileId = `cloud://test.${cloudPath}`;
      downloads.set(fileId, options.downloadContent || jpeg);
      const metadata = {
        url: "https://upload.example.test",
        token: "temporary-token",
        authorization: "temporary-signature",
        cosFileId: "encoded-file-metadata",
        fileId,
      };
      return options.flatUploadMetadata ? metadata : { data: metadata };
    },
    async downloadFile({ fileID }) {
      if (options.downloadError) throw options.downloadError;
      if (!downloads.has(fileID)) throw new Error("file not found");
      return { fileContent: downloads.get(fileID) };
    },
    async deleteFile({ fileList }) {
      deleted.push(...fileList);
      if (options.deleteError) throw options.deleteError;
      if (typeof options.deleteResultFactory === "function") return options.deleteResultFactory(fileList);
      return { fileList: fileList.map((fileID) => ({ fileID, code: "SUCCESS" })) };
    },
    ai() {
      return { createModel(provider) {
        assert.equal(provider, "cloudbase");
        return { async generateText(input) {
          if (options.modelError) throw options.modelError;
          if (options.onGenerate) options.onGenerate(input);
          if (options.modelResponse) return structuredClone(options.modelResponse);
          return { text: options.modelText || JSON.stringify({
            sourceType: "daily_list",
            detectedScope: "",
            weekLabel: "",
            truncated: false,
            drafts: [{
            subject: "数学", title: "完成练习", content: "第 1 页", extraRequirement: "订正错题",
            deadlineExplicit: true, deadline: "2026-09-14T20:00:00+08:00", uncertainFields: [],
          }],
          }) };
        } };
      } };
    },
  };

  const { createAiService } = loadAiModule({ database, cloudbaseApp });
  const service = createAiService({
    database,
    cloudbaseApp,
    environment: options.environment || { AI_MODEL: "glm-5v-turbo", AI_DAILY_LIMIT: "2" },
    now: () => new Date(currentTime),
    randomBytes: (size) => Buffer.alloc(size, randomCounter++),
    logger: { info: (...args) => logs.push(args), error: (...args) => logs.push(args) },
  });

  return {
    service,
    database,
    cloudbaseApp,
    getDocuments: () => documents,
    getJobs: () => [...documents.values()].filter((document) => document.type === "job"),
    getRateLimits: () => [...documents.values()].filter((document) => document.type === "rate_limit"),
    getDeleted: () => deleted,
    getMetadataCalls: () => metadataCalls,
    getLogs: () => logs,
    setTime: (value) => { currentTime = new Date(value); },
  };
}

const fileInput = () => [{ name: "qq-homework.jpg", mimeType: "image/jpeg", size: jpeg.length }];

test("CloudBase Node SDK 使用自身当前环境标识和六十秒超时初始化", () => {
  let input;
  loadAiModule({ onCloudbaseInit: (value) => { input = value; } });
  assert.equal(input.env, Symbol.for("TENCENTCLOUD_RUNENV"));
  assert.equal(input.timeout, 60000);
});

test("公开状态不泄露模型、额度和身份配置", async () => {
  const fixture = createFixture();
  assert.deepEqual(JSON.parse(JSON.stringify(await fixture.service.getStatus(testUser.openid))), {
    enabled: true,
    canImport: true,
    maxImages: 3,
    maxImageBytes: 4194304,
    blockedReason: "",
  });
  const serialized = JSON.stringify(await fixture.service.getStatus(testUser.openid));
  assert.equal(serialized.includes("glm"), false);
  assert.equal(serialized.includes(testUser.openid), false);

  const tokenHubKey = ["test", "tokenhub", "key", "1234567890"].join("-");
  const tokenHubFixture = createFixture({ environment: {
    AI_PROVIDER: "tokenhub",
    AI_MODEL: "glm-5.3-flash",
    AI_DAILY_LIMIT: "2",
    TOKENHUB_API_KEY: tokenHubKey,
  } });
  const tokenHubStatus = JSON.stringify(await tokenHubFixture.service.getStatus(testUser.openid));
  assert.equal(tokenHubStatus.includes("tokenhub"), false);
  assert.equal(tokenHubStatus.includes("glm-5.3-flash"), false);
  assert.equal(tokenHubStatus.includes(tokenHubKey), false);
});

test("无身份、未注册用户和孩子账号均不能创建导入任务", async () => {
  const child = { _id: "child-1", openid: "child-openid", familyId: "family-1", role: "child" };
  const fixture = createFixture({ users: [testUser, child] });
  await assert.rejects(fixture.service.createImportJob("", { files: fileInput() }), { message: "UNAUTHORIZED" });
  await assert.rejects(fixture.service.createImportJob("unknown", { files: fileInput() }), { message: "UNAUTHORIZED" });
  await assert.rejects(fixture.service.createImportJob(child.openid, { files: fileInput() }), { message: "FORBIDDEN" });
  assert.equal(fixture.getJobs().length, 0);
});

test("配置缺失时关闭状态并在创建凭据前拒绝", async () => {
  const fixture = createFixture({ environment: {} });
  assert.deepEqual(JSON.parse(JSON.stringify(await fixture.service.getStatus(testUser.openid))), {
    enabled: false,
    canImport: false,
    maxImages: 3,
    maxImageBytes: 4194304,
    blockedReason: "AI 图片导入尚未配置",
  });
  await assert.rejects(fixture.service.createImportJob(testUser.openid, { files: fileInput() }), { message: "CONFIGURATION" });
  assert.equal(fixture.getMetadataCalls().length, 0);
});

test("任务绑定服务端身份家庭与随机路径且不保存原始 OpenID 和上传凭据", async () => {
  const fixture = createFixture();
  const result = await fixture.service.createImportJob(testUser.openid, {
    files: fileInput(),
    importScope: "friday_weekend",
    openid: "forged-openid",
    familyId: "forged-family",
  });
  assert.match(result.jobId, /^[a-f0-9]{32}$/);
  assert.equal(result.uploads.length, 1);
  assert.deepEqual(Object.keys(result.uploads[0]).sort(), ["authorization", "cosFileId", "fileId", "index", "mimeType", "token", "uploadKey", "url"]);
  assert.equal(result.uploads[0].fileId.includes(result.jobId), true);
  assert.equal(result.uploads[0].uploadKey, encodeURIComponent(fixture.getMetadataCalls()[0]));
  assert.equal(result.uploads[0].authorization, "temporary-signature", "该字段同时用于 Signature 与 authorization 请求头");
  assert.equal(result.uploads[0].token, "temporary-token", "该字段用于 x-cos-security-token 请求头");
  assert.equal(result.uploads[0].cosFileId, "encoded-file-metadata", "该字段用于 x-cos-meta-fileid 请求头");
  assert.deepEqual(JSON.parse(JSON.stringify({
    Signature: result.uploads[0].authorization,
    authorization: result.uploads[0].authorization,
    key: result.uploads[0].uploadKey,
    "x-cos-security-token": result.uploads[0].token,
    "x-cos-meta-fileid": result.uploads[0].cosFileId,
  })), {
    Signature: "temporary-signature",
    authorization: "temporary-signature",
    key: encodeURIComponent(fixture.getMetadataCalls()[0]),
    "x-cos-security-token": "temporary-token",
    "x-cos-meta-fileid": "encoded-file-metadata",
  });
  const job = fixture.getJobs()[0];
  assert.equal(job.familyId, testUser.familyId);
  assert.equal(job.importType, "homework");
  assert.equal(job.importScope, "friday_weekend");
  assert.equal(job.openid, undefined);
  assert.equal(job.ownerHash.length, 64);
  assert.equal(JSON.stringify(job).includes("temporary-token"), false);
  assert.equal(JSON.stringify(job).includes("temporary-signature"), false);
  assert.equal(job.status, "awaiting_upload");
  assert.equal(fixture.getRateLimits()[0].openid, undefined);
});

test("创建任务拒绝非法识别范围且分析阶段只使用任务绑定范围", async () => {
  const fixture = createFixture();
  for (const importScope of ["sunday", null, "", 1]) {
    await assert.rejects(fixture.service.createImportJob(testUser.openid, {
      files: fileInput(),
      importScope,
    }), { message: "INVALID_IMPORT_SCOPE" });
  }
  assert.equal(fixture.getJobs().length, 0);

  let prompt = "";
  const boundFixture = createFixture({ onGenerate: (input) => {
    prompt = input.messages[0].content.find((item) => item.type === "text").text;
  } });
  const created = await boundFixture.service.createImportJob(testUser.openid, {
    files: fileInput(),
    importScope: "tuesday",
  });
  await boundFixture.service.analyzeImportJob(testUser.openid, {
    jobId: created.jobId,
    importScope: "full_week",
  });
  assert.match(prompt, /周表只提取“星期二”列/);
  assert.doesNotMatch(prompt, /周表所有非空星期列/);
});

test("通知任务绑定业务类型且分析阶段不能由客户端改写为作业", async () => {
  let prompt = "";
  const fixture = createFixture({
    modelText: JSON.stringify({
      truncated: false,
      drafts: [{
        title: "下周一家长会",
        source: "班主任",
        category: "activity",
        content: "请提前十分钟到场",
        eventTimeExplicit: true,
        eventTime: "2026-09-21T19:00:00+08:00",
        uncertainFields: [],
      }],
    }),
    onGenerate(input) {
      prompt = input.messages[0].content.find((item) => item.type === "text").text;
    },
  });
  const created = await fixture.service.createImportJob(testUser.openid, {
    files: fileInput(),
    importType: "notice",
    importScope: "full_week",
  });

  const result = await fixture.service.analyzeImportJob(testUser.openid, {
    jobId: created.jobId,
    importType: "homework",
  });

  const job = fixture.getJobs()[0];
  assert.equal(job.importType, "notice");
  assert.equal(job.importScope, "auto");
  assert.match(prompt, /学校通知信息提取器/);
  assert.doesNotMatch(prompt, /家庭作业信息提取器/);
  assert.equal(result.drafts[0].title, "下周一家长会");
  assert.equal(result.drafts[0].subject, undefined);
  assert.equal(result.drafts[0].suggestedRemindTime, "2026-09-21T11:00:00.000Z");
});

test("课程表任务使用课程表提示词和服务端课程格规范化", async () => {
  let prompt = "";
  const fixture = createFixture({
    modelText: JSON.stringify({
      truncated: false,
      entries: [{
        dayOfWeek: 1,
        period: 1,
        courseName: "语文",
        teacher: "李老师",
        location: "101",
        startTime: "08:00",
        endTime: "08:40",
        uncertainFields: [],
      }],
    }),
    onGenerate(input) {
      prompt = input.messages[0].content.find((item) => item.type === "text").text;
    },
  });
  const created = await fixture.service.createImportJob(testUser.openid, {
    files: fileInput(),
    importType: "timetable",
  });
  const result = await fixture.service.analyzeImportJob(testUser.openid, { jobId: created.jobId });

  assert.match(prompt, /学校课程表信息提取器/);
  assert.equal(result.entries[0].courseName, "语文");
  assert.equal(result.entries[0].semester, "2026下");
  assert.deepEqual(fixture.getDeleted(), [created.uploads[0].fileId]);
});

test("创建任务在申请上传凭据前拒绝非法业务类型", async () => {
  const fixture = createFixture();
  await assert.rejects(fixture.service.createImportJob(testUser.openid, {
    files: fileInput(),
    importType: "plan",
  }), { message: "INVALID_IMPORT_TYPE" });
  assert.equal(fixture.getMetadataCalls().length, 0);
  assert.equal(fixture.getJobs().length, 0);
});

test("上传元数据只接受 Node SDK 的 data 嵌套结构", async () => {
  const fixture = createFixture({ flatUploadMetadata: true });
  await assert.rejects(fixture.service.createImportJob(testUser.openid, { files: fileInput() }), {
    message: "UPLOAD_METADATA_UNAVAILABLE",
  });
  assert.equal(fixture.getJobs()[0].status, "failed");
});

test("北京时间每日额度在事务中原子计数并于次日刷新", async () => {
  const fixture = createFixture();
  const first = fixture.service.createImportJob(testUser.openid, { files: fileInput() });
  const second = fixture.service.createImportJob(testUser.openid, { files: fileInput() });
  const third = fixture.service.createImportJob(testUser.openid, { files: fileInput() });
  const results = await Promise.allSettled([first, second, third]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
  assert.equal(results.filter((result) => result.status === "rejected" && result.reason.message === "DAILY_LIMIT").length, 1);
  assert.equal(fixture.getRateLimits()[0].date, "2026-09-13");
  assert.equal(fixture.getRateLimits()[0].count, 2);

  fixture.setTime("2026-09-13T16:00:00.000Z");
  await fixture.service.createImportJob(testUser.openid, { files: fileInput() });
  assert.equal(fixture.getRateLimits().length, 2);
  assert.ok(fixture.getRateLimits().some((record) => record.date === "2026-09-14" && record.count === 1));
});

test("分析仅接受当前用户当前家庭且处于待处理状态的任务", async () => {
  const fixture = createFixture();
  const created = await fixture.service.createImportJob(testUser.openid, { files: fileInput() });
  await assert.rejects(fixture.service.analyzeImportJob(otherUser.openid, { jobId: created.jobId }), { message: "JOB_FORBIDDEN" });
  assert.equal(fixture.getDeleted().length, 0, "越权请求不能删除他人的临时文件");
  await fixture.service.analyzeImportJob(testUser.openid, { jobId: created.jobId });
  await assert.rejects(fixture.service.analyzeImportJob(testUser.openid, { jobId: created.jobId }), { message: "JOB_STATE" });
});

test("用户切换家庭后拒绝识别但仍清理原家庭临时文件", async () => {
  const users = [{ ...testUser }];
  const fixture = createFixture({ users });
  const created = await fixture.service.createImportJob(testUser.openid, { files: fileInput() });
  users[0].familyId = "family-2";
  await assert.rejects(fixture.service.analyzeImportJob(testUser.openid, { jobId: created.jobId }), { message: "JOB_FORBIDDEN" });
  assert.deepEqual(fixture.getDeleted(), [created.uploads[0].fileId]);
  assert.equal(fixture.getJobs()[0].status, "failed");
});

test("用户上传后降权或配置失效均拒绝识别并立即清理", async () => {
  const users = [{ ...testUser }];
  const roleFixture = createFixture({ users });
  const roleJob = await roleFixture.service.createImportJob(testUser.openid, { files: fileInput() });
  users[0].role = "child";
  await assert.rejects(roleFixture.service.analyzeImportJob(testUser.openid, { jobId: roleJob.jobId }), { message: "FORBIDDEN" });
  assert.deepEqual(roleFixture.getDeleted(), [roleJob.uploads[0].fileId]);

  const environment = { AI_MODEL: "glm-5v-turbo", AI_DAILY_LIMIT: "2" };
  const configFixture = createFixture({ environment });
  const configJob = await configFixture.service.createImportJob(testUser.openid, { files: fileInput() });
  delete environment.AI_MODEL;
  await assert.rejects(configFixture.service.analyzeImportJob(testUser.openid, { jobId: configJob.jobId }), { message: "CONFIGURATION" });
  assert.deepEqual(configFixture.getDeleted(), [configJob.uploads[0].fileId]);
});

test("过期任务不会调用模型并在清理后标记为过期", async () => {
  let modelCalled = false;
  const fixture = createFixture({ onGenerate: () => { modelCalled = true; } });
  const created = await fixture.service.createImportJob(testUser.openid, { files: fileInput() });
  fixture.setTime("2026-09-13T16:10:00.000Z");
  await assert.rejects(fixture.service.analyzeImportJob(testUser.openid, { jobId: created.jobId }), { message: "JOB_EXPIRED" });
  assert.equal(modelCalled, false);
  assert.deepEqual(fixture.getDeleted(), [created.uploads[0].fileId]);
  assert.equal(fixture.getJobs()[0].status, "expired");
});

test("上传失败后可取消自己的任务并清理已上传临时文件", async () => {
  const fixture = createFixture();
  const created = await fixture.service.createImportJob(testUser.openid, { files: fileInput() });
  const result = await fixture.service.cancelImportJob(testUser.openid, { jobId: created.jobId });
  assert.equal(result.cleanupRequired, false);
  assert.deepEqual(fixture.getDeleted(), [created.uploads[0].fileId]);
  assert.equal(fixture.getJobs()[0].status, "canceled");
  await assert.rejects(fixture.service.cancelImportJob(testUser.openid, { jobId: created.jobId }), { message: "JOB_STATE" });
});

test("取消任务重新校验所有者且配置关闭后仍允许清理", async () => {
  const environment = { AI_MODEL: "glm-5v-turbo", AI_DAILY_LIMIT: "2" };
  const fixture = createFixture({ environment });
  const created = await fixture.service.createImportJob(testUser.openid, { files: fileInput() });
  await assert.rejects(fixture.service.cancelImportJob(otherUser.openid, { jobId: created.jobId }), { message: "JOB_FORBIDDEN" });
  assert.equal(fixture.getDeleted().length, 0);
  delete environment.AI_MODEL;
  const result = await fixture.service.cancelImportJob(testUser.openid, { jobId: created.jobId });
  assert.equal(result.cleanupRequired, false);
  assert.deepEqual(fixture.getDeleted(), [created.uploads[0].fileId]);
});

test("原任务所有者在角色和家庭变化后仍可取消清理且他人不能删除", async () => {
  const users = [{ ...testUser }, { ...otherUser }];
  const fixture = createFixture({ users });
  const created = await fixture.service.createImportJob(testUser.openid, { files: fileInput() });
  users[0].role = "child";
  users[0].familyId = "family-2";
  await assert.rejects(fixture.service.cancelImportJob(otherUser.openid, { jobId: created.jobId }), { message: "JOB_FORBIDDEN" });
  assert.equal(fixture.getDeleted().length, 0);
  const result = await fixture.service.cancelImportJob(testUser.openid, { jobId: created.jobId });
  assert.equal(result.cleanupRequired, false);
  assert.deepEqual(fixture.getDeleted(), [created.uploads[0].fileId]);
});

test("AI 上下文仅向模型提供清洗去重后的前五十个科目", async () => {
  let modelInput;
  const subjects = ["  语文 ", "语文", ...Array.from({ length: 55 }, (_, index) => `科目${index}`)];
  const fixture = createFixture({ subjects, onGenerate: (input) => { modelInput = input; } });
  const created = await fixture.service.createImportJob(testUser.openid, { files: fileInput() });
  await fixture.service.analyzeImportJob(testUser.openid, { jobId: created.jobId });
  const prompt = modelInput.messages[0].content.find((item) => item.type === "text").text;
  assert.match(prompt, /语文、科目0/);
  assert.match(prompt, /科目48/);
  assert.doesNotMatch(prompt, /科目49/);
});

test("成功识别时校验图片、调用托管模型、规范化草稿并删除临时文件", async () => {
  let modelInput;
  const fixture = createFixture({ onGenerate: (input) => { modelInput = input; } });
  const created = await fixture.service.createImportJob(testUser.openid, { files: fileInput() });
  const result = await fixture.service.analyzeImportJob(testUser.openid, { jobId: created.jobId });
  assert.equal(result.drafts[0].semester, "2026下");
  assert.equal(result.drafts[0].subject, "数学");
  assert.equal(result.drafts[0].homeworkDate, "2026-09-13");
  assert.equal(result.drafts[0].title, "完成练习\n第 1 页\n订正错题");
  assert.equal(result.drafts[0].content, "");
  assert.equal(result.drafts[0].hasDeadline, true);
  assert.equal(result.drafts[0].deadline, "2026-09-14T12:00:00.000Z");
  assert.equal(result.summary.sourceType, "daily_list");
  assert.equal(result.summary.scopeLabel, "全部作业");
  assert.equal(result.warnings.length, 0);
  assert.equal(modelInput.model, "glm-5v-turbo");
  assert.equal(modelInput.max_tokens, 4000);
  assert.equal(modelInput.messages[0].content.map((item) => item.type).join(","), "image_url,text");
  assert.equal(modelInput.messages[0].content.some((item) => item.type === "image_url" && item.image_url.url.startsWith("data:image/jpeg;base64,")), true);
  assert.equal(modelInput.messages[0].content.find((item) => item.type === "image_url").image_url.detail, "high");
  assert.deepEqual(fixture.getDeleted(), [created.uploads[0].fileId]);
  const job = fixture.getJobs()[0];
  assert.equal(job.status, "completed");
  assert.equal(job.cleanupRequired, false);
  assert.equal(JSON.stringify(job).includes("完成练习"), false, "任务文档不能保存识别正文");
});

test("跨北京时间午夜的模型响应仍使用识别开始日期推算本周", async () => {
  let prompt = "";
  const fixture = createFixture({
    modelText: JSON.stringify({ sourceType: "weekly_table", detectedScope: "monday", drafts: [{ subject: "数学", title: "卷《有理数》", sourceWeekday: "monday" }] }),
    onGenerate(input) {
      prompt = input.messages[0].content.find((part) => part.type === "text").text;
      fixture.setTime("2026-09-13T16:00:01.000Z");
    },
  });
  const created = await fixture.service.createImportJob(testUser.openid, { files: fileInput() });
  const result = await fixture.service.analyzeImportJob(testUser.openid, { jobId: created.jobId });
  assert.match(prompt, /北京时间日期：2026-09-13/);
  assert.equal(result.drafts[0].homeworkDate, "2026-09-07");
  assert.equal(result.drafts[0].dateSource, "inferred_week");
  assert.equal(result.drafts[0].hasDeadline, false);
  assert.deepEqual(fixture.getDeleted(), [created.uploads[0].fileId]);
});

test("旧任务缺少识别范围时分析按智能判断兼容", async () => {
  let prompt = "";
  const fixture = createFixture({ onGenerate: (input) => {
    prompt = input.messages[0].content.find((item) => item.type === "text").text;
  } });
  const created = await fixture.service.createImportJob(testUser.openid, { files: fileInput() });
  const entry = [...fixture.getDocuments().entries()].find(([, value]) => value.type === "job");
  const legacyJob = structuredClone(entry[1]);
  delete legacyJob.importScope;
  delete legacyJob.importType;
  fixture.getDocuments().set(entry[0], legacyJob);

  await fixture.service.analyzeImportJob(testUser.openid, { jobId: created.jobId });

  assert.match(prompt, /当前范围为自动判断/);
});

test("模型明确因长度停止时返回分批识别错误并清理截图", async () => {
  const fixture = createFixture({ modelResponse: {
    text: '{"sourceType":"weekly_table","drafts":[',
    rawResponses: [{ choices: [{ finish_reason: "length" }] }],
  } });
  const created = await fixture.service.createImportJob(testUser.openid, { files: fileInput(), importScope: "full_week" });

  await assert.rejects(fixture.service.analyzeImportJob(testUser.openid, { jobId: created.jobId }), {
    message: "MODEL_OUTPUT_TRUNCATED",
  });
  assert.deepEqual(fixture.getDeleted(), [created.uploads[0].fileId]);
});

test("模型正常结束可接收六十条并对超出上限结果提示分批导入", async () => {
  const createPayload = (count) => ({
    sourceType: "weekly_table",
    detectedScope: "friday_weekend",
    weekLabel: "第2周",
    truncated: false,
    drafts: Array.from({ length: count }, (_, index) => ({
      subject: "数学", title: `练习 ${index + 1}`, content: "", extraRequirement: "",
      deadlineExplicit: false, deadline: "", uncertainFields: [],
    })),
  });
  const fullFixture = createFixture({ modelResponse: {
    text: JSON.stringify(createPayload(60)),
    rawResponses: [{ choices: [{ finish_reason: "stop" }] }],
  } });
  const fullJob = await fullFixture.service.createImportJob(testUser.openid, { files: fileInput(), importScope: "full_week" });
  const fullResult = await fullFixture.service.analyzeImportJob(testUser.openid, { jobId: fullJob.jobId });
  assert.equal(fullResult.drafts.length, 60);
  assert.doesNotMatch(fullResult.warnings.join("；"), /分批导入/);

  const overflowFixture = createFixture({ modelResponse: {
    text: JSON.stringify(createPayload(61)),
    rawResponses: [{ choices: [{ finish_reason: "stop" }] }],
  } });
  const overflowJob = await overflowFixture.service.createImportJob(testUser.openid, { files: fileInput(), importScope: "full_week" });
  const overflowResult = await overflowFixture.service.analyzeImportJob(testUser.openid, { jobId: overflowJob.jobId });
  assert.equal(overflowResult.drafts.length, 60);
  assert.match(overflowResult.warnings.join("；"), /选择具体星期分批导入/);
});

test("任务中文件标识被伪造时在模型调用前拒绝并执行清理", async () => {
  let modelCalled = false;
  const fixture = createFixture({ onGenerate: () => { modelCalled = true; } });
  const created = await fixture.service.createImportJob(testUser.openid, { files: fileInput() });
  const job = fixture.getJobs()[0];
  job.files[0].fileId = "cloud://test.ai-imports/other/file.jpg";
  const document = [...fixture.getDocuments().entries()].find(([, value]) => value.type === "job");
  fixture.getDocuments().set(document[0], job);
  await assert.rejects(fixture.service.analyzeImportJob(testUser.openid, { jobId: created.jobId }), { message: "INVALID_JOB_FILE" });
  assert.equal(modelCalled, false);
  assert.deepEqual(fixture.getDeleted(), [], "伪造文件标识不能被服务端用于删除其他对象");
  assert.equal(fixture.getJobs()[0].status, "failed");
  assert.equal(fixture.getJobs()[0].cleanupRequired, true);
});

test("真实文件魔数或长度不符时拒绝模型调用并在 finally 清理", async () => {
  for (const content of [Buffer.from("not-an-image!!"), Buffer.concat([jpeg, Buffer.from([0])])]) {
    let modelCalled = false;
    const fixture = createFixture({ downloadContent: content, onGenerate: () => { modelCalled = true; } });
    const created = await fixture.service.createImportJob(testUser.openid, { files: fileInput() });
    await assert.rejects(fixture.service.analyzeImportJob(testUser.openid, { jobId: created.jobId }));
    assert.equal(modelCalled, false);
    assert.deepEqual(fixture.getDeleted(), [created.uploads[0].fileId]);
  }
});

test("模型返回非 JSON 时任务失败且仍删除临时文件", async () => {
  const fixture = createFixture({ modelText: "识别到一条数学作业" });
  const created = await fixture.service.createImportJob(testUser.openid, { files: fileInput() });
  await assert.rejects(fixture.service.analyzeImportJob(testUser.openid, { jobId: created.jobId }), { message: "INVALID_MODEL_JSON" });
  assert.deepEqual(fixture.getDeleted(), [created.uploads[0].fileId]);
  assert.equal(fixture.getJobs()[0].status, "failed");
});

test("删除失败不丢失识别结果并将任务标记为待清理", async () => {
  const deleteError = new Error("secret-delete-error");
  deleteError.code = "STORAGE_REQUEST_FAIL";
  const fixture = createFixture({ deleteError });
  const created = await fixture.service.createImportJob(testUser.openid, { files: fileInput() });
  const result = await fixture.service.analyzeImportJob(testUser.openid, { jobId: created.jobId });
  assert.equal(result.drafts.length, 1);
  assert.equal(fixture.getJobs()[0].status, "completed");
  assert.equal(fixture.getJobs()[0].cleanupRequired, true);
  assert.equal(JSON.stringify(fixture.getLogs()).includes("STORAGE_REQUEST_FAIL"), true);
  assert.equal(JSON.stringify(fixture.getLogs()).includes("secret-delete-error"), false);
});

test("删除接口正常返回单文件失败时仍标记为待清理", async () => {
  const fixture = createFixture({
    deleteResultFactory: (fileList) => ({
      fileList: fileList.map((fileID) => ({ fileID, code: "UNKNOWN_STORAGE_FAILURE" })),
    }),
  });
  const created = await fixture.service.createImportJob(testUser.openid, { files: fileInput() });

  const result = await fixture.service.analyzeImportJob(testUser.openid, { jobId: created.jobId });

  assert.equal(result.drafts.length, 1);
  assert.equal(fixture.getJobs()[0].status, "completed");
  assert.equal(fixture.getJobs()[0].cleanupRequired, true);
  assert.equal(JSON.stringify(fixture.getLogs()).includes("UNKNOWN_STORAGE_FAILURE"), false);
  assert.equal(JSON.stringify(fixture.getLogs()).includes("INTERNAL"), true);
});

test("取消混合合法与伪造文件的任务时只删除绑定文件并保留待清理标记", async () => {
  const fixture = createFixture();
  const files = [
    { name: "one.jpg", mimeType: "image/jpeg", size: jpeg.length },
    { name: "two.jpg", mimeType: "image/jpeg", size: jpeg.length },
  ];
  const created = await fixture.service.createImportJob(testUser.openid, { files });
  const entry = [...fixture.getDocuments().entries()].find(([, value]) => value.type === "job");
  const job = structuredClone(entry[1]);
  job.files[1].fileId = "cloud://test.ai-imports/other/forged.jpg";
  fixture.getDocuments().set(entry[0], job);

  const result = await fixture.service.cancelImportJob(testUser.openid, { jobId: created.jobId });

  assert.equal(result.cleanupRequired, true);
  assert.deepEqual(fixture.getDeleted(), [created.uploads[0].fileId]);
  assert.equal(fixture.getJobs()[0].cleanupRequired, true);
});

test("清理日志将非白名单错误码归一为 INTERNAL 且不记录异常正文", async () => {
  const deleteError = new Error("secret-storage-payload");
  deleteError.code = "SECRET_PROVIDER_CODE";
  const fixture = createFixture({ deleteError });
  const created = await fixture.service.createImportJob(testUser.openid, { files: fileInput() });
  await fixture.service.analyzeImportJob(testUser.openid, { jobId: created.jobId });
  const serialized = JSON.stringify(fixture.getLogs());
  assert.equal(serialized.includes("INTERNAL"), true);
  assert.equal(serialized.includes("SECRET_PROVIDER_CODE"), false);
  assert.equal(serialized.includes("secret-storage-payload"), false);
});

test("入口将身份、权限、额度和内部错误映射为稳定公开响应且日志不泄露载荷", async () => {
  const fixture = createFixture();
  const safeLogs = [];
  const { main } = loadAiModule({
    database: fixture.database,
    cloudbaseApp: fixture.cloudbaseApp,
    environment: { AI_MODEL: "glm-5v-turbo", AI_DAILY_LIMIT: "2" },
    context: {},
    console: { info() {}, error: (...args) => safeLogs.push(args) },
  });
  const secret = "sensitive-client-payload";
  const result = await main({ action: secret, content: secret });
  assert.equal(result.success, false);
  assert.equal(result.message, "请先登录并加入家庭");
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(safeLogs).includes(secret), false);
});
