const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const {
  MAX_IMAGE_BYTES,
  MAX_DRAFTS,
  validateSelectedFiles,
  uploadFileWithCredential,
  createEditableDrafts,
  createHomeworkPayload,
  checkPossibleDuplicates,
} = require("../miniprogram/utils/ai-import");
const { canPerform } = require("../miniprogram/utils/permissions");

const TEST_JOB_ID = "0123456789abcdef0123456789abcdef";

function imageFile(overrides = {}) {
  return {
    tempFilePath: "/tmp/homework.jpg",
    size: MAX_IMAGE_BYTES,
    fileType: "image",
    mimeType: "image/jpeg",
    ...overrides,
  };
}

test("AI 作业导入权限只授予创建者和普通成员", () => {
  assert.equal(canPerform("creator", "importHomework"), true);
  assert.equal(canPerform("member", "importHomework"), true);
  assert.equal(canPerform("child", "importHomework"), false);
  assert.equal(canPerform("unknown", "importHomework"), false);
});

test("作业列表对有权限用户保留 AI 导入入口并由点击处理不可用状态", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/homework-list/homework-list.js"), "utf8");
  const template = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/homework-list/homework-list.wxml"), "utf8");

  assert.match(source, /canUseImport:\s*false/);
  assert.match(source, /canPerform\(session\.user\.role,\s*"importHomework"\)/);
  assert.match(source, /if \(!this\.data\.canImport\)/);
  assert.match(source, /content:\s*this\.data\.importBlockedReason/);
  assert.match(template, /wx:if="\{\{canUseImport\}\}"/);
  assert.doesNotMatch(template, /wx:if="\{\{canImport\}\}"/);
});

test("截图校验接受一至三张 JPEG 或 PNG 且包含四兆字节边界", () => {
  const files = validateSelectedFiles([
    imageFile(),
    imageFile({ tempFilePath: "/tmp/homework.png", size: 1024, mimeType: "image/png" }),
  ]);

  assert.deepEqual(files.map(({ name, mimeType, size }) => ({ name, mimeType, size })), [
    { name: "image-1.jpg", mimeType: "image/jpeg", size: MAX_IMAGE_BYTES },
    { name: "image-2.png", mimeType: "image/png", size: 1024 },
  ]);
  assert.throws(() => validateSelectedFiles([]), /请选择 1 至 3 张截图/);
  assert.throws(() => validateSelectedFiles([imageFile(), imageFile(), imageFile(), imageFile()]), /最多选择 3 张截图/);
});

test("截图校验拒绝超限文件和非 JPEG PNG 格式", () => {
  assert.throws(() => validateSelectedFiles([imageFile({ size: MAX_IMAGE_BYTES + 1 })]), /不能超过 4 MB/);
  assert.throws(() => validateSelectedFiles([imageFile({ tempFilePath: "/tmp/homework.webp" })]), /仅支持 JPEG、PNG/);
  assert.throws(() => validateSelectedFiles([imageFile({ tempFilePath: "/tmp/homework.jpg", mimeType: "image/png" })]), /文件格式与扩展名不一致/);
  assert.throws(() => validateSelectedFiles([imageFile({ fileType: "video" })]), /不是截图/);
});

test("临时截图使用服务端凭据通过 HTTPS PUT 上传", async () => {
  const body = new Uint8Array([0xFF, 0xD8, 0xFF]).buffer;
  const calls = [];
  const requestTask = { abort() {} };
  let observedRequestTask;
  const wxApi = {
    getFileSystemManager() {
      return {
        readFile(options) {
          calls.push({ type: "read", options });
          options.success({ data: body });
        },
      };
    },
    request(options) {
      calls.push({ type: "request", options });
      options.success({ statusCode: 200 });
      return requestTask;
    },
  };
  const file = imageFile({ size: 3 });

  await uploadFileWithCredential(file, {
    url: "https://example.cos.ap-shanghai.myqcloud.com/object",
    token: "temporary-token",
    authorization: "temporary-authorization",
    cosFileId: "cos-object-id",
    fileId: "cloud://environment/object",
    mimeType: "image/jpeg",
    uploadKey: "ai-imports%2F0123456789abcdef%2F0123456789abcdef0123456789abcdef%2F0.jpg",
  }, wxApi, (task) => {
    observedRequestTask = task;
  });

  const request = calls.find((item) => item.type === "request").options;
  assert.equal(request.method, "PUT");
  assert.equal(request.timeout, 60000);
  assert.equal(request.data, body);
  assert.deepEqual(request.header, {
    Signature: "temporary-authorization",
    authorization: "temporary-authorization",
    key: "ai-imports%2F0123456789abcdef%2F0123456789abcdef0123456789abcdef%2F0.jpg",
    "x-cos-security-token": "temporary-token",
    "x-cos-meta-fileid": "cos-object-id",
  });
  assert.equal(observedRequestTask, requestTask);
});

test("临时截图上传接受 COS 的三种成功状态码", async () => {
  for (const statusCode of [200, 201, 204]) {
    const wxApi = {
      getFileSystemManager() {
        return { readFile({ success }) { success({ data: new Uint8Array([0xFF, 0xD8, 0xFF]).buffer }); } };
      },
      request({ success }) { success({ statusCode }); },
    };
    await uploadFileWithCredential(imageFile({ size: 3 }), {
      url: "https://example.com/upload",
      token: "token",
      authorization: "authorization",
      cosFileId: "cos-id",
      fileId: "cloud://environment/object",
      mimeType: "image/jpeg",
      uploadKey: "ai-imports%2F0123456789abcdef%2F0123456789abcdef0123456789abcdef%2F0.jpg",
    }, wxApi);
  }
});

test("临时截图上传拒绝非 HTTPS 凭据、字节变化和非成功状态码", async () => {
  const validCredential = {
    url: "https://example.com/upload",
    token: "token",
    authorization: "authorization",
    cosFileId: "cos-id",
    fileId: "cloud://environment/object",
    mimeType: "image/jpeg",
    uploadKey: "ai-imports%2F0123456789abcdef%2F0123456789abcdef0123456789abcdef%2F0.jpg",
  };
  const createWx = (statusCode = 200) => ({
    getFileSystemManager() {
      return { readFile({ success }) { success({ data: new Uint8Array([0xFF, 0xD8, 0xFF]).buffer }); } };
    },
    request({ success }) { success({ statusCode }); },
  });

  await assert.rejects(uploadFileWithCredential(imageFile({ size: 3 }), { ...validCredential, url: "http://example.com/upload" }, createWx()), /上传地址不安全/);
  await assert.rejects(uploadFileWithCredential(imageFile({ size: 3 }), { ...validCredential, uploadKey: "..%2Fforeign.jpg" }, createWx()), /上传路径不正确/);
  await assert.rejects(uploadFileWithCredential(imageFile({ size: 4 }), validCredential, createWx()), /截图内容已发生变化/);
  await assert.rejects(uploadFileWithCredential(imageFile({ size: 3 }), validCredential, createWx(403)), /截图上传失败/);
});

test("临时截图上传会在发送前核对真实文件格式", async () => {
  const wxApi = {
    getFileSystemManager() {
      return { readFile({ success }) { success({ data: new Uint8Array([1, 2, 3]).buffer }); } };
    },
    request() { throw new Error("格式错误时不应发起上传"); },
  };

  await assert.rejects(uploadFileWithCredential(imageFile({ size: 3 }), {
    url: "https://example.com/upload",
    token: "token",
    authorization: "authorization",
    cosFileId: "cos-id",
    fileId: "cloud://environment/object",
    mimeType: "image/jpeg",
    uploadKey: "ai-imports%2F0123456789abcdef%2F0123456789abcdef0123456789abcdef%2F0.jpg",
  }, wxApi), /实际格式不是 JPEG 或 PNG/);
});

test("同一识别草稿重复保存会复用安全稳定的请求编号", () => {
  const [draft] = createEditableDrafts([
    { semester: "2026下", subject: "数学", title: "练习册", content: "第 20 页", extraRequirement: "", hasDeadline: false, deadline: "" },
  ], ["语文", "数学"], "2026下", TEST_JOB_ID);

  const firstPayload = createHomeworkPayload(draft);
  const retryPayload = createHomeworkPayload({ ...draft, saveError: "网络响应未知" });

  assert.equal(firstPayload.requestId, `${TEST_JOB_ID}_0`);
  assert.equal(retryPayload.requestId, firstPayload.requestId);
  assert.match(firstPayload.requestId, /^[A-Za-z0-9_-]{16,64}$/);
  assert.throws(() => createEditableDrafts([{}], [], "2026下", "short"), /识别任务编号无效/);
  assert.throws(() => createHomeworkPayload({ ...draft, requestId: "a".repeat(65) }), /识别草稿编号无效/);
});

test("可编辑草稿保留不确定字段并支持六十条整周作业", () => {
  const drafts = createEditableDrafts(Array.from({ length: 62 }, (_, index) => ({
    semester: "2026下",
    subject: "数学",
    title: `练习 ${index + 1}`,
    content: "完成题目",
    extraRequirement: "",
    hasDeadline: false,
    deadline: "",
    uncertainFields: index === 0 ? ["title", "deadline", "ignored"] : [],
  })), ["数学"], "2026下", TEST_JOB_ID);

  assert.equal(drafts.length, 60);
  assert.deepEqual(drafts[0].uncertainFields, ["title", "deadline"]);
  assert.equal(drafts[0].titleUncertain, true);
  assert.equal(drafts[0].deadlineUncertain, true);
  assert.equal(drafts[0].possibleDuplicate, false);
});

test("重复检查只读取最近五十条并默认取消精确重复草稿", async () => {
  const drafts = createEditableDrafts([
    { semester: "2026下", subject: "语文", title: "背诵课文", content: "第一段", extraRequirement: "", hasDeadline: false },
    { semester: "2026下", subject: "数学", title: "练习册", content: "第20页", extraRequirement: "订正", hasDeadline: false },
  ], ["语文", "数学"], "2026下", TEST_JOB_ID);
  const calls = [];
  const result = await checkPossibleDuplicates(drafts, "2026下", async (input) => {
    calls.push(input);
    const items = Array.from({ length: 50 }, (_, index) => ({
      semester: "2026下", subject: "其他", title: `已有 ${index}`, content: "", extraRequirement: "",
    }));
    items[0] = {
      semester: "2026下", subject: "数学", title: "练习册", content: "第20页", extraRequirement: "订正",
      homeworkDate: drafts[1].homeworkDate,
    };
    return { items, hasMore: true, truncated: true };
  });

  assert.deepEqual(calls, [{
    semester: "2026下",
    subject: "全部",
    status: "all",
    keyword: "",
    sortMode: "created_at_desc",
    page: 1,
    pageSize: 50,
  }]);
  assert.equal(result.drafts[0].selected, true);
  assert.equal(result.drafts[1].possibleDuplicate, true);
  assert.equal(result.drafts[1].selected, false);
  assert.doesNotMatch(result.warning, /500/);
});

test("重复检查会标记同批完全重复但保留相似作业", async () => {
  const drafts = createEditableDrafts([
    { semester: "2026下", subject: "数学", title: "练习册", content: "第20页", extraRequirement: "订正" },
    { semester: "2026下", subject: "数学", title: "练习册", content: "第20页", extraRequirement: "订正" },
    { semester: "2026下", subject: "数学", title: "练习册", content: "第21页", extraRequirement: "订正" },
  ], ["数学"], "2026下", TEST_JOB_ID);

  const result = await checkPossibleDuplicates(drafts, "2026下", async () => ({ items: [] }));

  assert.equal(result.drafts[0].possibleDuplicate, false);
  assert.equal(result.drafts[0].selected, true);
  assert.equal(result.drafts[1].possibleDuplicate, true);
  assert.equal(result.drafts[1].selected, false);
  assert.equal(result.drafts[2].possibleDuplicate, false);
  assert.equal(result.drafts[2].selected, true);
});

test("日期参与重复检查且未知历史日期不误判为今天", async () => {
  const base = { semester: "2026下", subject: "数学", title: "卷《有理数》", content: "", extraRequirement: "" };
  const drafts = createEditableDrafts([
    { ...base, homeworkDate: "2026-09-14" },
    { ...base, homeworkDate: "2026-09-15" },
    { ...base, homeworkDate: "2026-09-15" },
  ], ["数学"], "2026下", TEST_JOB_ID);
  const result = await checkPossibleDuplicates(drafts, "2026下", async () => ({ items: [base] }));
  assert.deepEqual(result.drafts.map((draft) => draft.possibleDuplicate), [false, false, true]);
  const sameDay = await checkPossibleDuplicates(drafts.slice(0, 1), "2026下", async () => ({ items: [{ ...base, homeworkDate: "2026-09-14" }] }));
  assert.equal(sameDay.drafts[0].possibleDuplicate, true);
});

test("保存载荷保留长主题和作业日期并拒绝非法或超限输入", () => {
  const [draft] = createEditableDrafts([{ subject: "数学", homeworkDate: "2026-09-14", title: "原文".repeat(50) }], ["数学"], "2026下", TEST_JOB_ID);
  const payload = createHomeworkPayload(draft);
  assert.equal(payload.title, draft.title);
  assert.equal(payload.homeworkDate, "2026-09-14");
  assert.equal(payload.content, "");
  for (const homeworkDate of ["", "2026-02-29", "2026-09-31"]) {
    assert.throws(() => createHomeworkPayload({ ...draft, homeworkDate }), /作业日期/);
  }
  const [tooLong] = createEditableDrafts([{ ...draft, title: "题".repeat(501) }], ["数学"], "2026下", TEST_JOB_ID);
  assert.equal(tooLong.title.length, 501);
  assert.throws(() => createHomeworkPayload(tooLong), /500/);
});

test("重复检查失败时保留全部草稿选择且不阻断识别", async () => {
  const drafts = createEditableDrafts([
    { semester: "2026下", subject: "语文", title: "背诵课文", content: "第一段", extraRequirement: "", hasDeadline: false },
  ], ["语文"], "2026下", TEST_JOB_ID);
  const result = await checkPossibleDuplicates(drafts, "2026下", async () => {
    throw new Error("数据库暂时不可用");
  });

  assert.equal(result.drafts[0].selected, true);
  assert.equal(result.drafts[0].possibleDuplicate, false);
  assert.match(result.warning, /重复检查失败/);
});

function setByPath(target, key, value) {
  const segments = key.match(/[^.[\]]+/g);
  let current = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (current[segment] === undefined) current[segment] = /^\d+$/.test(segments[index + 1]) ? [] : {};
    current = current[segment];
  }
  current[segments.at(-1)] = value;
}

function loadImportPage(overrides = {}) {
  const sourcePath = path.resolve(__dirname, "../miniprogram/pages/homework-import/homework-import.js");
  const source = fs.readFileSync(sourcePath, "utf8");
  let pageConfig;
  const calls = [];
  const navigations = [];
  const toasts = [];
  const guards = [];
  const session = overrides.session || {
    user: { role: "creator", familyId: "family-id" },
    family: { currentSemester: "2026下", educationStage: "junior_high" },
  };
  const requireFamily = overrides.requireFamily || (async () => session);
  const callFunction = overrides.callFunction || (async (name, action, data) => {
    calls.push({ name, action, data });
    if (name === "settings") return { subjects: ["语文", "数学"] };
    if (name === "ai" && action === "getStatus") return { enabled: true, canImport: true, maxImages: 3, maxImageBytes: MAX_IMAGE_BYTES, blockedReason: "" };
    throw new Error(`测试未实现请求：${name}.${action}`);
  });
  const wxApi = {
    showToast(options) { toasts.push(options); },
    navigateBack() { navigations.push("back"); },
    enableAlertBeforeUnload(options) { guards.push({ type: "enable", options }); },
    disableAlertBeforeUnload() { guards.push({ type: "disable" }); },
    chooseMedia: overrides.chooseMedia || (async () => ({ tempFiles: [] })),
  };
  const moduleValue = { exports: {} };
  const context = vm.createContext({
    Page(config) { pageConfig = config; },
    wx: wxApi,
    console: { error() {} },
    Date,
    Promise,
    setTimeout,
    clearTimeout,
    module: moduleValue,
    exports: moduleValue.exports,
    require(request) {
      if (request === "../../utils/api") return { callFunction, showError(error) { toasts.push({ title: error.message, icon: "none" }); } };
      if (request === "../../utils/session") return { requireFamily };
      if (request === "../../utils/ai-import") {
        return {
          MAX_IMAGE_BYTES,
          MAX_DRAFTS,
          validateSelectedFiles,
          uploadFileWithCredential: overrides.uploadFileWithCredential || (async () => {}),
          createEditableDrafts: require("../miniprogram/utils/ai-import").createEditableDrafts,
          createHomeworkPayload: require("../miniprogram/utils/ai-import").createHomeworkPayload,
          checkPossibleDuplicates: require("../miniprogram/utils/ai-import").checkPossibleDuplicates,
        };
      }
      if (request === "../../utils/permissions") return { canPerform };
      if (request === "../../utils/constants") return { DEFAULT_SUBJECTS: { junior_high: ["语文", "数学"] } };
      if (request === "../../utils/share") return require("../miniprogram/utils/share");
      if (request === "../../utils/date") return require("../miniprogram/utils/date");
      throw new Error(`测试未实现依赖：${request}`);
    },
  });
  vm.runInContext(source, context, { filename: sourcePath });
  const page = {
    data: JSON.parse(JSON.stringify(pageConfig.data)),
    setData(changes) {
      for (const [key, value] of Object.entries(changes)) setByPath(this.data, key, value);
    },
  };
  for (const [name, value] of Object.entries(pageConfig)) {
    if (typeof value === "function") page[name] = value.bind(page);
  }
  return { page, calls, navigations, toasts, guards };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("孩子直接进入导入页会被拒绝且不会调用 AI", async () => {
  const fixture = loadImportPage({
    session: {
      user: { role: "child", familyId: "family-id" },
      family: { currentSemester: "2026下", educationStage: "junior_high" },
    },
  });

  await fixture.page.onLoad();

  assert.deepEqual(fixture.navigations, ["back"]);
  assert.equal(fixture.calls.length, 0);
  await fixture.page.chooseScreenshots();
  assert.match(fixture.toasts.at(-1).title, /孩子账号不能使用 AI 导入/);
});

test("识别流程按顺序申请凭据、上传并识别但不自动保存", async () => {
  const files = [imageFile({ size: 2 }), imageFile({ tempFilePath: "/tmp/second.png", size: 2, mimeType: "image/png" })];
  const events = [];
  const fixture = loadImportPage({
    chooseMedia: async (options) => {
      events.push({ type: "choose", options });
      return { tempFiles: files };
    },
    uploadFileWithCredential: async (file, credential) => events.push({ type: "upload", file, credential }),
    async callFunction(name, action, data) {
      events.push({ type: "call", name, action, data });
      if (name === "settings") return { subjects: ["语文", "数学"] };
      if (name === "ai" && action === "getStatus") return { enabled: true, canImport: true, maxImages: 3, maxImageBytes: MAX_IMAGE_BYTES };
      if (name === "ai" && action === "createImportJob") return {
        jobId: TEST_JOB_ID,
        uploads: [
          { url: "https://example.com/one", token: "one", authorization: "one", cosFileId: "one", fileId: "cloud://one", mimeType: "image/jpeg" },
          { url: "https://example.com/two", token: "two", authorization: "two", cosFileId: "two", fileId: "cloud://two", mimeType: "image/png" },
        ],
      };
      if (name === "ai" && action === "analyzeImportJob") return {
        drafts: [{ semester: "2026下", subject: "数学", title: "练习册", content: "第 20 页", extraRequirement: "订正", hasDeadline: false, deadline: "" }],
        warnings: ["请核对题号"],
        summary: { sourceType: "daily_list", sourceTypeLabel: "单日作业清单", scopeLabel: "全部作业", weekLabel: "" },
      };
      if (name === "homework" && action === "list") return { items: [], hasMore: false, truncated: false };
      if (name === "homework" && action === "create") throw new Error("识别阶段不得保存作业");
      throw new Error(`测试未实现请求：${name}.${action}`);
    },
  });
  await fixture.page.onLoad();

  await fixture.page.chooseScreenshots();
  await fixture.page.recognize();

  assert.deepEqual(JSON.parse(JSON.stringify(events[2].options)), { count: 3, mediaType: ["image"], sourceType: ["album", "camera"], sizeType: ["original", "compressed"] });
  assert.deepEqual(JSON.parse(JSON.stringify(events.filter((item) => item.type === "call" && item.action === "createImportJob")[0].data)), {
    importScope: "auto",
    files: [
      { name: "image-1.jpg", mimeType: "image/jpeg", size: 2 },
      { name: "image-2.png", mimeType: "image/png", size: 2 },
    ],
  });
  assert.equal(events.filter((item) => item.type === "upload").length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(events.filter((item) => item.type === "call" && item.action === "analyzeImportJob")[0].data)), { jobId: TEST_JOB_ID });
  assert.equal(events.some((item) => item.name === "homework" && item.action === "create"), false);
  assert.equal(events.filter((item) => item.name === "homework" && item.action === "list").length, 1);
  assert.equal(fixture.page.data.drafts[0].selected, true);
  assert.equal(fixture.page.data.drafts[0].saved, false);
  assert.equal(fixture.page.data.drafts[0].requestId, `${TEST_JOB_ID}_0`);
  assert.equal(fixture.page.data.phase, "ready");
  assert.equal(fixture.page.data.summary.sourceTypeLabel, "单日作业清单");
  assert.equal(fixture.page.data.summary.scopeLabel, "全部作业");
  assert.equal(fixture.guards.some((item) => item.type === "enable"), true);
});

test("页面默认智能判断且允许选择周表星期或整周范围", async () => {
  const template = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/homework-import/homework-import.wxml"), "utf8");
  const fixture = loadImportPage();
  await fixture.page.onLoad();

  assert.equal(fixture.page.data.importScope, "auto");
  assert.deepEqual(fixture.page.data.importScopes.map((item) => item.value), [
    "auto", "monday", "tuesday", "wednesday", "thursday", "friday_weekend", "full_week",
  ]);
  fixture.page.changeImportScope({ detail: { value: "full_week" } });
  assert.equal(fixture.page.data.importScope, "full_week");
  assert.match(template, /周表取最新一列，单日图取全部/);
  assert.match(template, /仅检查当前学期最近 50 条已有作业/);
  assert.match(template, /radio-group/);
});

test("识别后重复作业默认取消勾选并可由用户重新勾选", async () => {
  const fixture = loadImportPage({
    async callFunction(name, action) {
      if (name === "settings") return { subjects: ["语文", "数学"] };
      if (name === "ai" && action === "getStatus") return { enabled: true, canImport: true };
      if (name === "ai" && action === "createImportJob") return { jobId: TEST_JOB_ID, uploads: [{ url: "https://example.com/one" }] };
      if (name === "ai" && action === "analyzeImportJob") return {
        drafts: [{ semester: "2026下", subject: "语文", homeworkDate: "2026-09-14", title: "背诵课文", content: "第一段", extraRequirement: "", hasDeadline: false, uncertainFields: [] }],
        warnings: [],
        summary: { sourceType: "weekly_table", sourceTypeLabel: "周作业登记表", scopeLabel: "星期五/周末", weekLabel: "第2周" },
      };
      if (name === "homework" && action === "list") return {
        items: [{ semester: "2026下", subject: "语文", homeworkDate: "2026-09-14", title: "背诵课文", content: "第一段", extraRequirement: "" }],
        hasMore: false,
        truncated: false,
      };
      throw new Error(`测试未实现请求：${name}.${action}`);
    },
  });
  await fixture.page.onLoad();
  fixture.page.setData({ selectedFiles: [imageFile({ size: 3 })] });

  await fixture.page.recognize();

  assert.equal(fixture.page.data.drafts[0].possibleDuplicate, true);
  assert.equal(fixture.page.data.drafts[0].selected, false);
  assert.match(fixture.page.data.warnings.join("；"), /可能重复/);
  fixture.page.toggleDraft({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(fixture.page.data.drafts[0].selected, true);
});

test("人工修改识别字段会清除对应不确定和旧重复标记", async () => {
  const fixture = loadImportPage();
  await fixture.page.onLoad();
  fixture.page.setData({
    drafts: [{
      saved: false,
      title: "模糊字迹",
      uncertainFields: ["title", "content"],
      titleUncertain: true,
      contentUncertain: true,
      possibleDuplicate: true,
    }],
  });

  fixture.page.onDraftInput({
    currentTarget: { dataset: { index: 0, field: "title" } },
    detail: { value: "背诵课文" },
  });

  assert.equal(fixture.page.data.drafts[0].title, "背诵课文");
  assert.equal(fixture.page.data.drafts[0].titleUncertain, false);
  assert.deepEqual(fixture.page.data.drafts[0].uncertainFields, ["content"]);
  assert.equal(fixture.page.data.drafts[0].possibleDuplicate, false);
});

test("人工修改作业日期清除推测提示且不改动截止时间", async () => {
  const fixture = loadImportPage();
  await fixture.page.onLoad();
  fixture.page.setData({ drafts: [{
    saved: false, homeworkDate: "2026-09-14", dateSource: "inferred_week", homeworkDateUncertain: true,
    uncertainFields: ["homeworkDate", "title"], possibleDuplicate: true, hasDeadline: true, deadlineDate: "2026-09-20",
  }] });
  fixture.page.onHomeworkDate({ currentTarget: { dataset: { index: 0 } }, detail: { value: "2026-09-07" } });
  const draft = fixture.page.data.drafts[0];
  assert.equal(draft.homeworkDate, "2026-09-07");
  assert.equal(draft.homeworkDateText, "2026-09-07 周一");
  assert.equal(draft.dateSource, "manual");
  assert.equal(draft.homeworkDateUncertain, false);
  assert.deepEqual(draft.uncertainFields, ["title"]);
  assert.equal(draft.possibleDuplicate, false);
  assert.equal(draft.deadlineDate, "2026-09-20");
  draft.saved = true;
  fixture.page.onHomeworkDate({ currentTarget: { dataset: { index: 0 } }, detail: { value: "2026-09-08" } });
  assert.equal(draft.homeworkDate, "2026-09-07");
});

test("服务端异常返回超过六十条时客户端截断并明确提示", async () => {
  const fixture = loadImportPage({
    async callFunction(name, action) {
      if (name === "settings") return { subjects: ["语文"] };
      if (name === "ai" && action === "getStatus") return { enabled: true, canImport: true };
      if (name === "ai" && action === "createImportJob") return { jobId: TEST_JOB_ID, uploads: [{ url: "https://example.com/one" }] };
      if (name === "ai" && action === "analyzeImportJob") return {
        drafts: Array.from({ length: MAX_DRAFTS + 2 }, (_, index) => ({
          semester: "2026下", subject: "语文", title: `作业 ${index + 1}`, content: "", extraRequirement: "", hasDeadline: false,
        })),
        warnings: [],
      };
      if (name === "homework" && action === "list") return { items: [], hasMore: false, truncated: false };
      throw new Error(`测试未实现请求：${name}.${action}`);
    },
  });
  await fixture.page.onLoad();
  fixture.page.setData({ selectedFiles: [imageFile({ size: 3 })] });

  await fixture.page.recognize();

  assert.equal(fixture.page.data.drafts.length, MAX_DRAFTS);
  assert.match(fixture.page.data.warnings.join("；"), /客户端一次最多展示 60 条/);
});

test("权限检查延迟时连续点击识别只创建一个任务", async () => {
  const session = {
    user: { role: "creator", familyId: "family-id" },
    family: { currentSemester: "2026下", educationStage: "junior_high" },
  };
  const permissionGate = createDeferred();
  let permissionCallCount = 0;
  let createCount = 0;
  let analyzeCount = 0;
  const fixture = loadImportPage({
    session,
    async requireFamily() {
      permissionCallCount += 1;
      if (permissionCallCount === 1) return session;
      return permissionGate.promise;
    },
    async callFunction(name, action) {
      if (name === "settings") return { subjects: ["语文", "数学"] };
      if (name === "ai" && action === "getStatus") return { enabled: true, canImport: true, maxImages: 3, maxImageBytes: MAX_IMAGE_BYTES };
      if (name === "ai" && action === "createImportJob") {
        createCount += 1;
        return { jobId: TEST_JOB_ID, uploads: [{ url: "https://example.com/one" }] };
      }
      if (name === "ai" && action === "analyzeImportJob") {
        analyzeCount += 1;
        return { drafts: [{ semester: "2026下", subject: "数学", title: "练习册", content: "第 20 页", extraRequirement: "", hasDeadline: false, deadline: "" }], warnings: [] };
      }
      throw new Error(`测试未实现请求：${name}.${action}`);
    },
  });
  await fixture.page.onLoad();
  fixture.page.setData({ selectedFiles: [imageFile({ size: 3 })] });

  const firstRecognition = fixture.page.recognize();
  const secondRecognition = fixture.page.recognize();

  assert.equal(fixture.page.data.processing, true);
  assert.equal(permissionCallCount, 2);
  permissionGate.resolve(session);
  await Promise.all([firstRecognition, secondRecognition]);

  assert.equal(createCount, 1);
  assert.equal(analyzeCount, 1);
  assert.equal(fixture.page.data.processing, false);
});

test("部分截图上传失败会取消任务并保留原错误且不保存作业", async () => {
  const calls = [];
  let uploadCount = 0;
  const fixture = loadImportPage({
    chooseMedia: async () => ({
      tempFiles: [
        imageFile({ size: 3 }),
        imageFile({ tempFilePath: "/tmp/second.png", size: 8, mimeType: "image/png" }),
      ],
    }),
    async uploadFileWithCredential() {
      uploadCount += 1;
      if (uploadCount === 2) throw new Error("第二张截图上传超时");
    },
    async callFunction(name, action, data) {
      calls.push({ name, action, data });
      if (name === "settings") return { subjects: ["语文", "数学"] };
      if (name === "ai" && action === "getStatus") return { enabled: true, canImport: true, maxImages: 3, maxImageBytes: MAX_IMAGE_BYTES };
      if (name === "ai" && action === "createImportJob") return {
        jobId: "job-id",
        uploads: [
          { url: "https://example.com/one" },
          { url: "https://example.com/two" },
        ],
      };
      if (name === "ai" && action === "cancelImportJob") throw new Error("取消任务失败");
      throw new Error(`不应调用：${name}.${action}`);
    },
  });
  await fixture.page.onLoad();
  await fixture.page.chooseScreenshots();

  await fixture.page.recognize();

  const cancelCall = calls.find((item) => item.name === "ai" && item.action === "cancelImportJob");
  assert.deepEqual(JSON.parse(JSON.stringify(cancelCall.data)), { jobId: "job-id" });
  assert.equal(calls.some((item) => item.action === "analyzeImportJob"), false);
  assert.equal(calls.some((item) => item.name === "homework"), false);
  assert.equal(fixture.toasts.at(-1).title, "第二张截图上传超时");
  assert.equal(fixture.page.data.selectedFiles.length, 2);
});

test("识别请求未送达时会取消任务并清理临时截图", async () => {
  const calls = [];
  const fixture = loadImportPage({
    chooseMedia: async () => ({ tempFiles: [imageFile({ size: 3 })] }),
    async callFunction(name, action, data) {
      calls.push({ name, action, data });
      if (name === "settings") return { subjects: ["语文", "数学"] };
      if (name === "ai" && action === "getStatus") return { enabled: true, canImport: true, maxImages: 3, maxImageBytes: MAX_IMAGE_BYTES };
      if (name === "ai" && action === "createImportJob") return {
        jobId: "job-id",
        uploads: [{ url: "https://example.com/one" }],
      };
      if (name === "ai" && action === "analyzeImportJob") throw new Error("识别请求发送失败");
      if (name === "ai" && action === "cancelImportJob") return { cancelled: true };
      throw new Error(`不应调用：${name}.${action}`);
    },
  });
  await fixture.page.onLoad();
  await fixture.page.chooseScreenshots();

  await fixture.page.recognize();

  const cancelCalls = calls.filter((item) => item.action === "cancelImportJob").map((item) => item.data);
  assert.deepEqual(JSON.parse(JSON.stringify(cancelCalls)), [{ jobId: "job-id" }]);
  assert.equal(fixture.toasts.at(-1).title, "识别请求发送失败");
  assert.equal(fixture.page.data.selectedFiles.length, 1);
});

test("页面卸载会先中止当前上传再取消服务端任务", async () => {
  const uploadStarted = createDeferred();
  const events = [];
  let rejectUpload;
  let analyzeCount = 0;
  const requestTask = {
    abort() {
      events.push("abort");
      rejectUpload(new Error("上传已中止"));
    },
  };
  const fixture = loadImportPage({
    uploadFileWithCredential(file, credential, wxApi, onRequestTask) {
      return new Promise((resolve, reject) => {
        rejectUpload = reject;
        onRequestTask(requestTask);
        uploadStarted.resolve();
      });
    },
    async callFunction(name, action, data) {
      if (name === "settings") return { subjects: ["语文", "数学"] };
      if (name === "ai" && action === "getStatus") return { enabled: true, canImport: true, maxImages: 3, maxImageBytes: MAX_IMAGE_BYTES };
      if (name === "ai" && action === "createImportJob") return { jobId: "job-id", uploads: [{ url: "https://example.com/one" }] };
      if (name === "ai" && action === "cancelImportJob") {
        events.push(`cancel:${data.jobId}`);
        return { cancelled: true };
      }
      if (name === "ai" && action === "analyzeImportJob") {
        analyzeCount += 1;
        return { drafts: [], warnings: [] };
      }
      throw new Error(`测试未实现请求：${name}.${action}`);
    },
  });
  await fixture.page.onLoad();
  fixture.page.setData({ selectedFiles: [imageFile({ size: 3 })] });

  const recognition = fixture.page.recognize();
  await uploadStarted.promise;
  fixture.page.onUnload();
  await recognition;

  assert.deepEqual(events, ["abort", "cancel:job-id"]);
  assert.equal(analyzeCount, 0);
  assert.equal(fixture.page.activeJobId, "");
});

test("保存草稿逐条创建作业并锁定成功项保留失败项", async () => {
  const createCalls = [];
  const fixture = loadImportPage({
    async callFunction(name, action, data) {
      if (name === "settings") return { subjects: ["语文", "数学"] };
      if (name === "ai" && action === "getStatus") return { enabled: true, canImport: true, maxImages: 3, maxImageBytes: MAX_IMAGE_BYTES };
      if (name === "homework" && action === "create") {
        createCalls.push(data);
        if (data.title === "第二条") throw new Error("服务暂时不可用");
        return { id: "homework-id" };
      }
      throw new Error(`测试未实现请求：${name}.${action}`);
    },
  });
  await fixture.page.onLoad();
  fixture.page.setData({
    drafts: [
      { requestId: `${TEST_JOB_ID}_0`, selected: true, saved: false, semester: "2026下", subject: "语文", homeworkDate: "2026-09-14", title: "第一条", content: "内容", extraRequirement: "", hasDeadline: false, deadlineDate: "", deadlineTime: "", saveError: "" },
      { requestId: `${TEST_JOB_ID}_1`, selected: true, saved: false, semester: "2026下", subject: "数学", homeworkDate: "2026-09-14", title: "第二条", content: "内容", extraRequirement: "", hasDeadline: false, deadlineDate: "", deadlineTime: "", saveError: "" },
    ],
  });

  await fixture.page.saveSelected();

  assert.equal(createCalls.length, 2);
  assert.deepEqual(createCalls[0], {
    requestId: `${TEST_JOB_ID}_0`,
    semester: "2026下",
    subject: "语文",
    title: "第一条",
    homeworkDate: "2026-09-14",
    content: "内容",
    extraRequirement: "",
    isImportant: false,
    hasDeadline: false,
    deadline: null,
    images: [],
    videos: [],
    links: [],
    extraTags: [],
  });
  assert.equal(fixture.page.data.drafts[0].saved, true);
  assert.equal(fixture.page.data.drafts[0].selected, false);
  assert.equal(fixture.page.data.drafts[1].saved, false);
  assert.equal(fixture.page.data.drafts[1].selected, true);
  assert.match(fixture.page.data.drafts[1].saveError, /服务暂时不可用/);
  assert.equal(fixture.page.data.saveProgress, "已保存 1 条，1 条失败");

  await fixture.page.saveSelected();

  assert.equal(createCalls.length, 3);
  assert.equal(createCalls[1].requestId, `${TEST_JOB_ID}_1`);
  assert.equal(createCalls[2].requestId, createCalls[1].requestId);
});

test("权限检查延迟时连续点击保存只创建一次作业", async () => {
  const session = {
    user: { role: "creator", familyId: "family-id" },
    family: { currentSemester: "2026下", educationStage: "junior_high" },
  };
  const permissionGate = createDeferred();
  let permissionCallCount = 0;
  let createCount = 0;
  const fixture = loadImportPage({
    session,
    async requireFamily() {
      permissionCallCount += 1;
      if (permissionCallCount === 1) return session;
      return permissionGate.promise;
    },
    async callFunction(name, action) {
      if (name === "settings") return { subjects: ["语文", "数学"] };
      if (name === "ai" && action === "getStatus") return { enabled: true, canImport: true, maxImages: 3, maxImageBytes: MAX_IMAGE_BYTES };
      if (name === "homework" && action === "create") {
        createCount += 1;
        return { id: "homework-id" };
      }
      throw new Error(`测试未实现请求：${name}.${action}`);
    },
  });
  await fixture.page.onLoad();
  fixture.page.setData({
    drafts: [{ requestId: `${TEST_JOB_ID}_0`, selected: true, saved: false, semester: "2026下", subject: "语文", homeworkDate: "2026-09-14", title: "第一条", content: "内容", extraRequirement: "", hasDeadline: false, deadlineDate: "", deadlineTime: "", saveError: "" }],
  });

  const firstSave = fixture.page.saveSelected();
  const secondSave = fixture.page.saveSelected();

  assert.equal(fixture.page.data.saving, true);
  assert.equal(permissionCallCount, 2);
  permissionGate.resolve(session);
  await Promise.all([firstSave, secondSave]);

  assert.equal(createCount, 1);
  assert.equal(fixture.page.data.drafts[0].saved, true);
  assert.equal(fixture.page.data.saving, false);
});

test("隐私说明区分正常立即删除与异常生命周期兜底", () => {
  const template = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/homework-import/homework-import.wxml"), "utf8");

  assert.match(template, /正常识别或取消后立即删除/);
  assert.match(template, /异常由云存储短期生命周期规则兜底删除/);
});

test("未选择和字段不完整的草稿不会保存", async () => {
  const fixture = loadImportPage();
  await fixture.page.onLoad();
  fixture.page.setData({ drafts: [{ requestId: `${TEST_JOB_ID}_0`, selected: true, saved: false, semester: "2026下", subject: "", title: "", content: "", extraRequirement: "", hasDeadline: false, saveError: "" }] });

  await fixture.page.saveSelected();

  assert.equal(fixture.page.data.drafts[0].saved, false);
  assert.match(fixture.page.data.drafts[0].saveError, /请选择科目并填写主题/);
});
