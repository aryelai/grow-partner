const cloud = require("wx-server-sdk");
const cloudbase = require("@cloudbase/node-sdk");
const crypto = require("node:crypto");
const {
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  parseAiConfiguration,
  validateImportFiles,
  validateImageBuffer,
  getBeijingDate,
  normalizeSubjects,
  validateImportScope,
  extractModelPayload,
  normalizeModelDrafts,
  buildRecognitionPrompt,
  hashIdentifier,
} = require("./core");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const database = cloud.database();
const cloudbaseApp = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV, timeout: 60000 });
const JOB_TTL_MS = 10 * 60 * 1000;
const MAX_MODEL_TOKENS = 4000;
const JOB_ID_PATTERN = /^[a-f0-9]{32}$/;
const SAFE_CLEANUP_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "NETWORK_ERROR",
  "STORAGE_FILE_NOT_FOUND",
  "STORAGE_PERMISSION_DENIED",
  "STORAGE_REQUEST_FAIL",
]);
const DEFAULT_SUBJECTS = {
  kindergarten: ["语言", "数学启蒙", "英语启蒙", "科学", "艺术", "体育", "社会"],
  primary: ["语文", "数学", "英语", "科学", "道德与法治", "音乐", "美术", "体育", "信息技术", "劳动"],
  junior_high: ["语文", "数学", "英语", "物理", "化学", "生物", "道德与法治", "历史", "地理", "音乐", "美术", "体育", "信息技术", "劳动技术"],
  senior_high: ["语文", "数学", "英语", "物理", "化学", "生物", "政治", "历史", "地理", "音乐", "美术", "体育", "通用技术", "信息技术"],
};

function documentMissing(error) {
  return Boolean(error && (error.code === "DOCUMENT_NOT_FOUND"
    || /document.*(?:does not exist|not found)/i.test(String(error.errMsg || error.message || ""))));
}

async function readJobDocument(source, id) {
  try {
    const result = await source.collection("ai_import_jobs").doc(id).get();
    return result && result.data ? result.data : null;
  } catch (error) {
    if (documentMissing(error)) return null;
    throw error;
  }
}

function getModelText(result) {
  if (result && typeof result.text === "string") return result.text;
  if (result && result.data && typeof result.data.text === "string") return result.data.text;
  const content = result && result.choices && result.choices[0]
    && result.choices[0].message && result.choices[0].message.content;
  if (typeof content === "string") return content;
  throw new Error("INVALID_MODEL_OUTPUT");
}

function inspectModelMetadata(value, state, depth = 0) {
  if (!value || typeof value !== "object" || depth > 5 || state.visited.has(value)) return;
  state.visited.add(value);
  if (typeof value.finish_reason === "string") state.reasons.push(value.finish_reason);
  if (typeof value.finishReason === "string") state.reasons.push(value.finishReason);
  const usage = value.usage;
  if (usage && typeof usage === "object") {
    const completionTokens = Number(usage.completion_tokens ?? usage.completionTokens);
    if (Number.isFinite(completionTokens)) state.completionTokens.push(completionTokens);
  }
  for (const key of ["choices", "rawResponses", "rawResponse", "data"]) {
    const child = value[key];
    if (Array.isArray(child)) {
      for (const item of child) inspectModelMetadata(item, state, depth + 1);
    } else {
      inspectModelMetadata(child, state, depth + 1);
    }
  }
}

function modelOutputTruncated(response, maxTokens) {
  const state = { reasons: [], completionTokens: [], visited: new WeakSet() };
  inspectModelMetadata(response, state);
  const reasons = state.reasons.map((value) => value.trim().toLowerCase());
  const truncated = reasons.some((reason) => [
    "length",
    "max_tokens",
    "max_token",
    "token_limit",
    "max_output_tokens",
    "continue",
    "incomplete",
  ].includes(reason));
  if (truncated) return true;
  const normallyFinished = reasons.some((reason) => ["stop", "end_turn", "completed", "complete"].includes(reason));
  return !normallyFinished && state.completionTokens.some((count) => count >= maxTokens);
}

function createAiService(dependencies) {
  const { database: db, cloudbaseApp: app, environment, now, randomBytes, logger } = dependencies;

  function requireOpenid(openid) {
    if (typeof openid !== "string" || !openid) throw new Error("UNAUTHORIZED");
    return openid;
  }

  function getOwnerHash(openid) {
    return hashIdentifier(["ai-import-owner", requireOpenid(openid)]);
  }

  async function requireUser(openid) {
    requireOpenid(openid);
    const result = await db.collection("users").where({ openid }).limit(1).get();
    const user = result && result.data && result.data[0];
    if (!user || !user.familyId || !["creator", "member", "child"].includes(user.role)) {
      throw new Error("UNAUTHORIZED");
    }
    return user;
  }

  async function requireImporter(openid) {
    const user = await requireUser(openid);
    if (user.role === "child") throw new Error("FORBIDDEN");
    return user;
  }

  function requireConfiguration() {
    const configuration = parseAiConfiguration(environment);
    if (!configuration.enabled) throw new Error("CONFIGURATION");
    return configuration;
  }

  async function getStatus(openid) {
    const user = await requireUser(openid);
    const configuration = parseAiConfiguration(environment);
    const allowed = user.role === "creator" || user.role === "member";
    return {
      enabled: configuration.enabled,
      canImport: configuration.enabled && allowed,
      maxImages: MAX_IMAGES,
      maxImageBytes: MAX_IMAGE_BYTES,
      blockedReason: configuration.enabled ? (allowed ? "" : "孩子账号不能使用 AI 导入") : "AI 作业导入尚未配置",
    };
  }

  function createJobFile(ownerHash, jobId, file, index) {
    const cloudPath = `ai-imports/${ownerHash.slice(0, 16)}/${jobId}/${index}.${file.extension}`;
    return { index, cloudPath, fileId: "", mimeType: file.mimeType, size: file.size, extension: file.extension };
  }

  async function reserveJob(user, configuration, files, importScope) {
    const timestamp = now();
    const date = getBeijingDate(timestamp);
    const ownerHash = getOwnerHash(user.openid);
    const rateId = hashIdentifier(["ai-import-rate", user.openid, date]);
    const jobId = randomBytes(16).toString("hex");
    const expiresAt = new Date(timestamp.getTime() + JOB_TTL_MS);
    const jobFiles = files.map((file, index) => createJobFile(ownerHash, jobId, file, index));
    await db.runTransaction(async (transaction) => {
      const current = await readJobDocument(transaction, rateId);
      const count = current && current.date === date && Number.isSafeInteger(current.count)
        ? Math.max(0, current.count) : 0;
      if (count >= configuration.dailyLimit) throw new Error("DAILY_LIMIT");
      await transaction.collection("ai_import_jobs").doc(rateId).set({ data: {
        type: "rate_limit", ownerHash, date, count: count + 1,
        createdAt: current && current.createdAt || timestamp, updatedAt: timestamp,
      } });
      await transaction.collection("ai_import_jobs").doc(jobId).set({ data: {
        type: "job", jobId, ownerHash, familyId: user.familyId, status: "preparing",
        importScope, files: jobFiles, expiresAt, cleanupRequired: false,
        createdAt: timestamp, updatedAt: timestamp,
      } });
    });
    return { jobId, expiresAt, files: jobFiles };
  }

  function normalizeUploadMetadata(response, file) {
    const metadata = response && response.data;
    const upload = metadata && {
      index: file.index,
      url: metadata.url,
      token: metadata.token,
      authorization: metadata.authorization,
      cosFileId: metadata.cosFileId,
      fileId: metadata.fileId || metadata.fileID,
      mimeType: file.mimeType,
      uploadKey: encodeURIComponent(file.cloudPath),
    };
    if (!upload || ![upload.url, upload.token, upload.authorization, upload.cosFileId, upload.fileId]
      .every((value) => typeof value === "string" && value)) throw new Error("UPLOAD_METADATA_UNAVAILABLE");
    if (!upload.fileId.endsWith(file.cloudPath)) {
      throw new Error("UPLOAD_METADATA_MISMATCH");
    }
    return upload;
  }

  async function createImportJob(openid, input = {}) {
    const user = await requireImporter(openid);
    const configuration = requireConfiguration();
    const files = validateImportFiles(input.files);
    const importScope = validateImportScope(input.importScope);
    const job = await reserveJob(user, configuration, files, importScope);
    try {
      const uploads = [];
      for (const file of job.files) {
        const response = await app.getUploadMetadata({ cloudPath: file.cloudPath });
        uploads.push(normalizeUploadMetadata(response, file));
      }
      const storedFiles = job.files.map((file, index) => ({ ...file, fileId: uploads[index].fileId }));
      await db.collection("ai_import_jobs").doc(job.jobId).update({
        data: { files: storedFiles, status: "awaiting_upload", updatedAt: now() },
      });
      return { jobId: job.jobId, expiresAt: job.expiresAt.toISOString(), uploads };
    } catch (error) {
      await db.collection("ai_import_jobs").doc(job.jobId).update({
        data: { status: "failed", updatedAt: now() },
      });
      throw error;
    }
  }

  function isBoundFile(job, file, index) {
    if (!file || typeof file !== "object" || file.index !== index) return false;
    const validType = (file.mimeType === "image/jpeg" && file.extension === "jpg")
      || (file.mimeType === "image/png" && file.extension === "png");
    if (!validType) return false;
    const expectedPath = `ai-imports/${job.ownerHash.slice(0, 16)}/${job.jobId}/${index}.${file.extension}`;
    return file.cloudPath === expectedPath
      && typeof file.fileId === "string"
      && file.fileId.endsWith(expectedPath)
      && Number.isSafeInteger(file.size)
      && file.size >= 1
      && file.size <= MAX_IMAGE_BYTES;
  }

  async function claimJob(openid, jobId) {
    return db.runTransaction(async (transaction) => {
      const job = await readJobDocument(transaction, jobId);
      const ownerHash = getOwnerHash(openid);
      if (!job || job.type !== "job" || job.ownerHash !== ownerHash) {
        throw new Error("JOB_FORBIDDEN");
      }
      if (job.status !== "awaiting_upload") throw new Error("JOB_STATE");
      const expiresAt = new Date(job.expiresAt);
      const claimError = Number.isNaN(expiresAt.getTime()) || expiresAt <= now() ? "JOB_EXPIRED" : "";
      await transaction.collection("ai_import_jobs").doc(jobId).update({
        data: { status: "processing", updatedAt: now() },
      });
      return { ...job, status: "processing", claimError };
    });
  }

  async function getFamilyContext(user) {
    const familyResult = await db.collection("families").doc(user.familyId).get();
    const family = familyResult && familyResult.data;
    if (!family || !/^\d{4}(上|下)$/.test(family.currentSemester)) throw new Error("FAMILY_UNAVAILABLE");
    const subjectResult = await db.collection("subjects").where({
      familyId: user.familyId,
      educationStage: family.educationStage,
      grade: family.grade,
    }).limit(1).get();
    const record = subjectResult && subjectResult.data && subjectResult.data[0];
    const sourceSubjects = record && Array.isArray(record.subjects)
      ? record.subjects
      : DEFAULT_SUBJECTS[family.educationStage] || [];
    return { semester: family.currentSemester, subjects: normalizeSubjects(sourceSubjects) };
  }

  async function recognize(job, configuration, context) {
    if (!Array.isArray(job.files) || job.files.length < 1 || job.files.length > MAX_IMAGES) {
      throw new Error("INVALID_JOB_FILE");
    }
    const imageParts = [];
    for (let index = 0; index < job.files.length; index += 1) {
      const file = job.files[index];
      if (!isBoundFile(job, file, index)) throw new Error("INVALID_JOB_FILE");
      const response = await app.downloadFile({ fileID: file.fileId });
      const buffer = response && Buffer.isBuffer(response.fileContent)
        ? response.fileContent
        : Buffer.isBuffer(response) ? response : null;
      validateImageBuffer(buffer, { mimeType: file.mimeType, expectedSize: file.size });
      imageParts.push({
        type: "image_url",
        image_url: { url: `data:${file.mimeType};base64,${buffer.toString("base64")}` },
      });
    }
    const prompt = buildRecognitionPrompt({
      date: getBeijingDate(now()),
      semester: context.semester,
      subjects: context.subjects,
      importScope: validateImportScope(job.importScope),
    });
    const model = app.ai().createModel("cloudbase");
    const response = await model.generateText({
      model: configuration.model,
      max_tokens: MAX_MODEL_TOKENS,
      messages: [{ role: "user", content: [...imageParts, { type: "text", text: prompt }] }],
    });
    if (modelOutputTruncated(response, MAX_MODEL_TOKENS)) throw new Error("MODEL_OUTPUT_TRUNCATED");
    return normalizeModelDrafts(extractModelPayload(getModelText(response)), {
      ...context,
      importScope: validateImportScope(job.importScope),
    });
  }

  function getCleanupErrorCode(error) {
    const code = error && typeof error.code === "string" ? error.code : "";
    return SAFE_CLEANUP_ERROR_CODES.has(code) ? code : "INTERNAL";
  }

  function deleteResultSucceeded(result, fileList) {
    if (!result || !Array.isArray(result.fileList) || result.fileList.length !== fileList.length) return false;
    const succeeded = new Set(result.fileList
      .filter((item) => item && item.code === "SUCCESS" && typeof item.fileID === "string")
      .map((item) => item.fileID));
    return fileList.every((fileId) => succeeded.has(fileId));
  }

  async function cleanupJobFiles(job, jobId, stage) {
    if (!job || !Array.isArray(job.files)) return false;
    const fileList = job.files
      .filter((file, index) => isBoundFile(job, file, index))
      .map((file) => file.fileId);
    let cleanupRequired = job.files.some((file, index) => !isBoundFile(job, file, index));
    if (!fileList.length) return cleanupRequired;
    try {
      const result = await app.deleteFile({ fileList });
      if (!deleteResultSucceeded(result, fileList)) {
        cleanupRequired = true;
        const failedItem = result && Array.isArray(result.fileList)
          ? result.fileList.find((item) => !item || item.code !== "SUCCESS")
          : null;
        logger.error("AI import cleanup failed", {
          jobId, stage, code: getCleanupErrorCode(failedItem),
        });
      }
    } catch (error) {
      cleanupRequired = true;
      logger.error("AI import cleanup failed", {
        jobId, stage, code: getCleanupErrorCode(error),
      });
    }
    return cleanupRequired;
  }

  async function analyzeImportJob(openid, input = {}) {
    const jobId = typeof input.jobId === "string" ? input.jobId.trim() : "";
    if (!JOB_ID_PATTERN.test(jobId)) throw new Error("INVALID_JOB_ID");
    let job;
    let status = "failed";
    let cleanupRequired = false;
    try {
      job = await claimJob(openid, jobId);
      if (job.claimError) {
        status = "expired";
        throw new Error(job.claimError);
      }
      const user = await requireImporter(openid);
      if (user.familyId !== job.familyId) throw new Error("JOB_FORBIDDEN");
      const configuration = requireConfiguration();
      const context = await getFamilyContext(user);
      const result = await recognize(job, configuration, context);
      status = "completed";
      return result;
    } finally {
      if (job) {
        cleanupRequired = await cleanupJobFiles(job, jobId, "cleanup");
        await db.collection("ai_import_jobs").doc(jobId).update({
          data: { status, cleanupRequired, updatedAt: now() },
        });
      }
    }
  }

  async function cancelImportJob(openid, input = {}) {
    const jobId = typeof input.jobId === "string" ? input.jobId.trim() : "";
    if (!JOB_ID_PATTERN.test(jobId)) throw new Error("INVALID_JOB_ID");
    const job = await db.runTransaction(async (transaction) => {
      const current = await readJobDocument(transaction, jobId);
      const ownerHash = getOwnerHash(openid);
      if (!current || current.type !== "job" || current.ownerHash !== ownerHash) {
        throw new Error("JOB_FORBIDDEN");
      }
      if (!["preparing", "awaiting_upload", "failed"].includes(current.status)) {
        throw new Error("JOB_STATE");
      }
      await transaction.collection("ai_import_jobs").doc(jobId).update({
        data: { status: "canceling", updatedAt: now() },
      });
      return { ...current, status: "canceling" };
    });
    const cleanupRequired = await cleanupJobFiles(job, jobId, "cancel");
    await db.collection("ai_import_jobs").doc(jobId).update({
      data: { status: "canceled", cleanupRequired, updatedAt: now() },
    });
    return { cleanupRequired };
  }

  return { getStatus, createImportJob, analyzeImportJob, cancelImportJob };
}

function success(data, message = "") {
  return { success: true, data, message };
}

function failure(message) {
  return { success: false, data: null, message };
}

const ERROR_MESSAGES = {
  UNAUTHORIZED: "请先登录并加入家庭",
  FORBIDDEN: "孩子账号不能使用 AI 导入",
  CONFIGURATION: "AI 作业导入尚未配置",
  DAILY_LIMIT: "今日 AI 导入次数已达上限，请明天再试",
  INVALID_FILE_COUNT: "请选择 1 至 3 张作业截图",
  INVALID_FILE_METADATA: "截图信息不完整",
  INVALID_FILE_TYPE: "仅支持 JPEG 或 PNG 截图",
  INVALID_FILE_SIZE: "单张截图不能超过 4 MB",
  INVALID_FILE_NAME: "截图文件名不正确",
  INVALID_IMPORT_SCOPE: "识别范围不正确，请重新选择",
  INVALID_JOB_ID: "导入任务编号不正确",
  JOB_FORBIDDEN: "导入任务不存在或无权访问",
  JOB_STATE: "导入任务已处理，请重新发起导入",
  JOB_EXPIRED: "导入任务已过期，请重新选择截图",
  INVALID_JOB_FILE: "临时截图校验失败，请重新导入",
  INVALID_IMAGE_CONTENT: "临时截图内容不正确，请重新导入",
  IMAGE_TOO_LARGE: "单张截图不能超过 4 MB",
  IMAGE_TYPE_MISMATCH: "临时截图格式不一致，请重新导入",
  IMAGE_SIZE_MISMATCH: "临时截图大小不一致，请重新导入",
  INVALID_MODEL_OUTPUT: "AI 识别结果格式异常，请重新尝试",
  MODEL_OUTPUT_TOO_LARGE: "AI 识别结果格式异常，请重新尝试",
  MODEL_OUTPUT_TRUNCATED: "识别内容较多，请选择具体星期分批识别",
  INVALID_MODEL_JSON: "AI 识别结果格式异常，请重新尝试",
  INVALID_MODEL_STRUCTURE: "AI 识别结果格式异常，请重新尝试",
  NO_VALID_DRAFTS: "没有识别到可用作业，请更换清晰截图",
};

function publicErrorMessage(error) {
  return ERROR_MESSAGES[error && error.message]
    || "AI 作业导入暂时不可用，请稍后重试";
}

const service = createAiService({
  database,
  cloudbaseApp,
  environment: process.env,
  now: () => new Date(),
  randomBytes: (size) => crypto.randomBytes(size),
  logger: console,
});

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return failure("请先登录并加入家庭");
  const action = ["getStatus", "createImportJob", "analyzeImportJob", "cancelImportJob"].includes(event.action)
    ? event.action : "unknown";
  try {
    switch (action) {
      case "getStatus": return success(await service.getStatus(OPENID));
      case "createImportJob": return success(await service.createImportJob(OPENID, event), "上传任务已创建");
      case "analyzeImportJob": return success(await service.analyzeImportJob(OPENID, event), "作业识别完成");
      case "cancelImportJob": return success(await service.cancelImportJob(OPENID, event), "临时截图已清理");
      default: return failure("不支持的操作");
    }
  } catch (error) {
    console.error("AI import action failed", { action, code: Object.hasOwn(ERROR_MESSAGES, error.message) ? error.message : "INTERNAL" });
    return failure(publicErrorMessage(error));
  }
};

exports.createAiService = createAiService;
