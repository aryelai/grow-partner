const { getBeijingDate, formatHomeworkDate } = require("./date");
const { validateIsoDate } = require("./validation");

const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_DRAFTS = 60;
const DUPLICATE_PAGE_SIZE = 50;
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png"]);
const UNCERTAIN_FIELDS = new Set(["subject", "title", "content", "extraRequirement", "homeworkDate", "deadline"]);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

function getExtension(filePath) {
  const matched = /\.([A-Za-z0-9]+)(?:[?#].*)?$/.exec(String(filePath || ""));
  return matched ? matched[1].toLowerCase() : "";
}

function getMimeType(extension) {
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "png") return "image/png";
  return "";
}

function validateSelectedFiles(tempFiles) {
  if (!Array.isArray(tempFiles) || tempFiles.length === 0) {
    throw new Error("请选择 1 至 3 张截图");
  }
  if (tempFiles.length > MAX_IMAGES) {
    throw new Error("最多选择 3 张截图");
  }

  return tempFiles.map((file, index) => {
    const tempFilePath = typeof file.tempFilePath === "string" ? file.tempFilePath : "";
    const extension = getExtension(tempFilePath);
    const mimeType = getMimeType(extension);
    const declaredMimeType = typeof file.mimeType === "string" ? file.mimeType.toLowerCase() : "";
    const size = Number(file.size);
    if (file.fileType && file.fileType !== "image") {
      throw new Error(`第 ${index + 1} 个文件不是截图`);
    }
    if (!tempFilePath || !ALLOWED_MIME_TYPES.has(mimeType)) {
      throw new Error(`第 ${index + 1} 张截图仅支持 JPEG、PNG 格式`);
    }
    if (declaredMimeType && (!ALLOWED_MIME_TYPES.has(declaredMimeType) || declaredMimeType !== mimeType)) {
      throw new Error(`第 ${index + 1} 张截图文件格式与扩展名不一致`);
    }
    if (!Number.isInteger(size) || size <= 0) {
      throw new Error(`第 ${index + 1} 张截图大小无效`);
    }
    if (size > MAX_IMAGE_BYTES) {
      throw new Error(`第 ${index + 1} 张截图不能超过 4 MB`);
    }
    return {
      tempFilePath,
      name: `image-${index + 1}.${extension === "jpeg" ? "jpg" : extension}`,
      mimeType,
      size,
    };
  });
}

function detectImageMimeType(data) {
  const bytes = new Uint8Array(data);
  if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return "image/jpeg";
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47
    && bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A) return "image/png";
  return "";
}

function readFileBuffer(filePath, wxApi) {
  return new Promise((resolve, reject) => {
    let fileSystem;
    try {
      fileSystem = wxApi.getFileSystemManager();
    } catch (error) {
      reject(new Error(`无法读取截图：${error.message}`));
      return;
    }
    fileSystem.readFile({
      filePath,
      success(result) { resolve(result.data); },
      fail(error) { reject(new Error(`无法读取截图：${error.errMsg || error.message || "未知错误"}`)); },
    });
  });
}

async function prepareEditedImage(tempFilePath, index, wxApi = wx) {
  if (typeof tempFilePath !== "string" || !tempFilePath || !Number.isInteger(index) || index < 0 || index >= MAX_IMAGES) throw new Error("裁剪结果无效，请重新选择图片");
  const info = await new Promise((resolve, reject) => {
    wxApi.getFileSystemManager().getFileInfo({ filePath: tempFilePath, success: resolve, fail(error) { reject(new Error(`无法读取裁剪图片：${error.errMsg || "未知错误"}`)); } });
  });
  if (!Number.isInteger(info.size) || info.size <= 0) throw new Error("裁剪图片大小无效");
  if (info.size > MAX_IMAGE_BYTES) throw new Error("裁剪图片不能超过 4 MB，请缩小识别区域");
  const data = await readFileBuffer(tempFilePath, wxApi);
  if (data.byteLength !== info.size) throw new Error("裁剪图片读取期间发生变化，请重新选择");
  // 微信图片编辑器的临时路径可能没有扩展名，以实际文件头确认格式。
  const mimeType = detectImageMimeType(data);
  if (!ALLOWED_MIME_TYPES.has(mimeType)) throw new Error("裁剪图片仅支持 JPEG、PNG 格式");
  return { tempFilePath, name: `image-${index + 1}.${mimeType === "image/png" ? "png" : "jpg"}`, mimeType, size: info.size };
}

function requestUpload(options, wxApi, onRequestTask) {
  return new Promise((resolve, reject) => {
    const requestTask = wxApi.request({
      ...options,
      success(result) {
        if (![200, 201, 204].includes(result.statusCode)) {
          reject(new Error(`截图上传失败（HTTP ${result.statusCode || "未知"}）`));
          return;
        }
        resolve();
      },
      fail(error) { reject(new Error(`截图上传失败：${error.errMsg || error.message || "网络异常"}`)); },
    });
    if (typeof onRequestTask === "function") onRequestTask(requestTask);
  });
}

async function uploadFileWithCredential(file, credential, wxApi = wx, onRequestTask) {
  if (!credential || !/^https:\/\/[^\s]+$/i.test(String(credential.url || ""))) {
    throw new Error("服务端返回的上传地址不安全");
  }
  for (const field of ["token", "authorization", "cosFileId", "fileId", "mimeType", "uploadKey"]) {
    if (typeof credential[field] !== "string" || !credential[field]) {
      throw new Error("服务端返回的上传凭据不完整");
    }
  }
  let cloudPath = "";
  try {
    cloudPath = decodeURIComponent(credential.uploadKey);
  } catch (error) {
    throw new Error("服务端返回的上传路径不正确");
  }
  if (!/^ai-imports\/[a-f0-9]{16}\/[a-f0-9]{32}\/[0-2]\.(jpg|png)$/.test(cloudPath)) {
    throw new Error("服务端返回的上传路径不正确");
  }
  if (credential.mimeType !== file.mimeType || !ALLOWED_MIME_TYPES.has(credential.mimeType)) {
    throw new Error("服务端返回的上传格式与截图不一致");
  }

  const data = await readFileBuffer(file.tempFilePath, wxApi);
  if (!data || !Number.isFinite(data.byteLength) || data.byteLength !== file.size) {
    throw new Error("截图内容已发生变化，请重新选择");
  }
  if (detectImageMimeType(data) !== file.mimeType) {
    throw new Error("截图实际格式不是 JPEG 或 PNG，请重新选择");
  }
  await requestUpload({
    url: credential.url,
    method: "PUT",
    timeout: 60000,
    data,
    header: {
      Signature: credential.authorization,
      authorization: credential.authorization,
      key: credential.uploadKey,
      "x-cos-security-token": credential.token,
      "x-cos-meta-fileid": credential.cosFileId,
    },
  }, wxApi, onRequestTask);
}

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function splitDeadline(deadline) {
  if (!deadline) return { hasDeadline: false, deadlineDate: "", deadlineTime: "" };
  const date = new Date(deadline);
  if (Number.isNaN(date.getTime())) return { hasDeadline: false, deadlineDate: "", deadlineTime: "" };
  const pad = (value) => String(value).padStart(2, "0");
  return {
    hasDeadline: true,
    deadlineDate: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    deadlineTime: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  };
}

function createEditableDrafts(drafts, subjects, semester, jobId) {
  const validSubjects = new Set(Array.isArray(subjects) ? subjects : []);
  if (!Array.isArray(drafts)) return [];
  return drafts.slice(0, MAX_DRAFTS).map((draft, index) => {
    const requestId = `${typeof jobId === "string" ? jobId.trim() : ""}_${index}`;
    if (!REQUEST_ID_PATTERN.test(requestId)) throw new Error("识别任务编号无效，请重新识别");
    const deadline = splitDeadline(draft && draft.hasDeadline === true ? draft.deadline : "");
    const subject = cleanText(draft && draft.subject, 20);
    const homeworkDate = validateIsoDate(draft && draft.homeworkDate) ? draft.homeworkDate : getBeijingDate();
    const dateSource = ["explicit", "inferred_week", "default_today"].includes(draft && draft.dateSource)
      ? draft.dateSource : "default_today";
    const uncertainFields = [...new Set(Array.isArray(draft && draft.uncertainFields)
      ? draft.uncertainFields.filter((field) => typeof field === "string" && UNCERTAIN_FIELDS.has(field))
      : [])];
    return {
      localId: `draft-${requestId}`,
      requestId,
      selected: true,
      saved: false,
      saveError: "",
      possibleDuplicate: false,
      semester: /^\d{4}(上|下)$/.test(String(draft && draft.semester)) ? draft.semester : semester,
      subject: validSubjects.has(subject) ? subject : "",
      title: typeof (draft && draft.title) === "string" ? draft.title.trim() : "",
      homeworkDate,
      homeworkDateText: formatHomeworkDate(homeworkDate),
      dateSource,
      homeworkDateUncertain: uncertainFields.includes("homeworkDate"),
      content: cleanText(draft && draft.content, 2000),
      extraRequirement: cleanText(draft && draft.extraRequirement, 100),
      uncertainFields,
      subjectUncertain: uncertainFields.includes("subject"),
      titleUncertain: uncertainFields.includes("title"),
      contentUncertain: uncertainFields.includes("content"),
      extraRequirementUncertain: uncertainFields.includes("extraRequirement"),
      deadlineUncertain: uncertainFields.includes("deadline"),
      ...deadline,
    };
  });
}

function createHomeworkFingerprint(item) {
  const semester = cleanText(item && item.semester, 8);
  const subject = cleanText(item && item.subject, 20);
  const title = typeof (item && item.title) === "string" ? item.title.trim() : "";
  if (!/^\d{4}(上|下)$/.test(semester) || !subject || !title) return "";
  return JSON.stringify([
    semester,
    subject,
    validateIsoDate(item && item.homeworkDate) ? item.homeworkDate : "",
    title,
    cleanText(item && item.content, 2000),
    cleanText(item && item.extraRequirement, 100),
  ]);
}

async function checkPossibleDuplicates(drafts, semester, loadPage) {
  const safeDrafts = Array.isArray(drafts)
    ? drafts.map((draft) => ({
      ...draft,
      uncertainFields: Array.isArray(draft.uncertainFields) ? [...draft.uncertainFields] : [],
    }))
    : [];
  if (typeof loadPage !== "function") {
    return { drafts: safeDrafts, warning: "重复检查失败，请保存前人工确认" };
  }

  try {
    const result = await loadPage({
      semester,
      subject: "全部",
      status: "all",
      keyword: "",
      sortMode: "created_at_desc",
      page: 1,
      pageSize: DUPLICATE_PAGE_SIZE,
    });
    if (!result || !Array.isArray(result.items)) throw new Error("INVALID_HOMEWORK_LIST");
    const existingItems = result.items.slice(0, DUPLICATE_PAGE_SIZE);

    const fingerprints = new Set(existingItems.map(createHomeworkFingerprint).filter(Boolean));
    let duplicateCount = 0;
    const checkedDrafts = safeDrafts.map((draft) => {
      const fingerprint = createHomeworkFingerprint(draft);
      const possibleDuplicate = Boolean(fingerprint) && fingerprints.has(fingerprint);
      if (fingerprint) fingerprints.add(fingerprint);
      if (possibleDuplicate) duplicateCount += 1;
      return possibleDuplicate ? { ...draft, possibleDuplicate: true, selected: false } : draft;
    });
    const warnings = [];
    if (duplicateCount) warnings.push(`发现 ${duplicateCount} 条可能重复作业，已默认取消勾选，可人工重新勾选`);
    return { drafts: checkedDrafts, warning: warnings.join("；") };
  } catch (error) {
    return {
      drafts: safeDrafts,
      warning: "重复检查失败，识别结果仍可继续核对和保存",
      error,
    };
  }
}

function createHomeworkPayload(draft) {
  const requestId = typeof (draft && draft.requestId) === "string" ? draft.requestId.trim() : "";
  const semester = cleanText(draft && draft.semester, 8);
  const subject = cleanText(draft && draft.subject, 20);
  const title = typeof (draft && draft.title) === "string" ? draft.title.trim() : "";
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error("识别草稿编号无效，请重新识别");
  }
  if (!/^\d{4}(上|下)$/.test(semester) || !subject || !title) {
    throw new Error("请选择科目并填写主题");
  }
  if (!validateIsoDate(draft.homeworkDate)) throw new Error("请选择正确的作业日期");
  if (title.length > 500) throw new Error("主题不能超过500字，请精简或拆分后保存");
  const hasDeadline = draft.hasDeadline === true;
  let deadline = null;
  if (hasDeadline) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(draft.deadlineDate || "")) || !/^\d{2}:\d{2}$/.test(String(draft.deadlineTime || ""))) {
      throw new Error("请填写正确的截止日期和时间");
    }
    const deadlineDate = new Date(`${draft.deadlineDate}T${draft.deadlineTime}:00`);
    if (Number.isNaN(deadlineDate.getTime())) throw new Error("请填写正确的截止日期和时间");
    deadline = deadlineDate.toISOString();
  }
  return {
    requestId,
    semester,
    subject,
    title,
    homeworkDate: draft.homeworkDate,
    content: cleanText(draft.content, 2000),
    extraRequirement: cleanText(draft.extraRequirement, 100),
    isImportant: false,
    hasDeadline,
    deadline,
    images: [],
    videos: [],
    links: [],
    extraTags: [],
  };
}

module.exports = {
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  MAX_DRAFTS,
  validateSelectedFiles,
  prepareEditedImage,
  uploadFileWithCredential,
  createEditableDrafts,
  checkPossibleDuplicates,
  createHomeworkPayload,
};
