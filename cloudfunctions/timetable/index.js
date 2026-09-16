const cloud = require("wx-server-sdk");
const {
  buildTimetableId,
  normalizeEntry,
  normalizeEntries,
  validateExpectedVersion,
  mergeTimetableEntries,
} = require("./core");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const database = cloud.database();

function documentMissing(error) {
  return Boolean(error && (error.code === "DOCUMENT_NOT_FOUND"
    || /document.*(?:does not exist|not found)/i.test(String(error.errMsg || error.message || ""))));
}

async function readDocument(source, id) {
  try {
    const result = await source.collection("timetables").doc(id).get();
    return result && result.data ? result.data : null;
  } catch (error) {
    if (documentMissing(error)) return null;
    throw error;
  }
}

function createTimetableService(dependencies) {
  const { database: db, now } = dependencies;

  async function requireContext(openid) {
    if (typeof openid !== "string" || !openid) throw new Error("UNAUTHORIZED");
    const userResult = await db.collection("users").where({ openid }).limit(1).get();
    const user = userResult && userResult.data && userResult.data[0];
    if (!user || !user.familyId || !["creator", "member", "child"].includes(user.role)) {
      throw new Error("UNAUTHORIZED");
    }
    const familyResult = await db.collection("families").doc(user.familyId).get();
    const family = familyResult && familyResult.data;
    if (!family || !/^\d{4}(上|下)$/.test(family.currentSemester)) throw new Error("FAMILY_UNAVAILABLE");
    return { user, semester: family.currentSemester };
  }

  function requireEditor(user) {
    if (!user || !["creator", "member"].includes(user.role)) throw new Error("FORBIDDEN");
  }

  function publicValue(document, semester) {
    if (document && (!Number.isSafeInteger(document.version) || document.version < 0)) {
      throw new Error("INVALID_DOCUMENT");
    }
    return {
      semester,
      version: document ? document.version : 0,
      entries: document ? normalizeEntries(document.entries) : [],
    };
  }

  async function get(openid) {
    const { user, semester } = await requireContext(openid);
    const id = buildTimetableId(user.familyId, semester);
    return publicValue(await readDocument(db, id), semester);
  }

  async function update(openid, input, transform) {
    const { user, semester } = await requireContext(openid);
    requireEditor(user);
    const expectedVersion = validateExpectedVersion(input && input.expectedVersion);
    const id = buildTimetableId(user.familyId, semester);
    const timestamp = now();
    return db.runTransaction(async (transaction) => {
      const current = await readDocument(transaction, id);
      const currentValue = publicValue(current, semester);
      if (currentValue.version !== expectedVersion) throw new Error("VERSION_CONFLICT");
      const result = transform(currentValue.entries);
      const entries = normalizeEntries(result.entries);
      const version = currentValue.version + 1;
      await transaction.collection("timetables").doc(id).set({ data: {
        familyId: user.familyId,
        semester,
        version,
        entries,
        createdAt: current && current.createdAt || timestamp,
        updatedAt: timestamp,
        updatedBy: user.openid,
      } });
      return { semester, version, entries, ...result.metadata };
    });
  }

  async function saveEntry(openid, input = {}) {
    const entry = normalizeEntry(input.entry);
    return update(openid, input, (current) => {
      const entries = current.filter((item) => item.dayOfWeek !== entry.dayOfWeek || item.period !== entry.period);
      entries.push(entry);
      return { entries };
    });
  }

  async function removeEntry(openid, input = {}) {
    const coordinate = normalizeEntry({
      dayOfWeek: input.dayOfWeek,
      period: input.period,
      courseName: "占位",
    });
    return update(openid, input, (current) => ({
      entries: current.filter((item) => item.dayOfWeek !== coordinate.dayOfWeek || item.period !== coordinate.period),
    }));
  }

  async function mergeEntries(openid, input = {}) {
    const incoming = normalizeEntries(input.entries);
    if (!incoming.length) throw new Error("INVALID_ENTRIES");
    return update(openid, input, (current) => {
      const merged = mergeTimetableEntries(current, incoming);
      return {
        entries: merged.entries,
        metadata: { addedCount: merged.addedCount, replacedCount: merged.replacedCount },
      };
    });
  }

  return { get, saveEntry, removeEntry, mergeEntries };
}

function success(data, message = "") {
  return { success: true, data, message };
}

function failure(message) {
  return { success: false, data: null, message };
}

const ERROR_MESSAGES = {
  UNAUTHORIZED: "请先登录并加入家庭",
  FORBIDDEN: "孩子账号不能修改课程表",
  FAMILY_UNAVAILABLE: "家庭当前学期不可用，请先检查设置",
  INVALID_SEMESTER: "课程表学期不正确",
  INVALID_ENTRY: "课程信息不完整",
  INVALID_ENTRIES: "请选择至少一个有效课程格",
  INVALID_DAY: "星期不正确，请重新选择",
  INVALID_PERIOD: "节次不正确，请重新选择",
  INVALID_COURSE_NAME: "请填写科目名称",
  INVALID_TIME_RANGE: "上课时间范围不正确",
  DUPLICATE_ENTRY: "同一星期和节次只能有一门课程",
  INVALID_VERSION: "课程表版本不正确，请重新加载",
  INVALID_DOCUMENT: "课程表数据异常，请联系管理员检查",
  VERSION_CONFLICT: "课程表已被家庭成员更新，请重新加载后再保存",
};

function publicErrorMessage(error) {
  return ERROR_MESSAGES[error && error.message] || "课程表服务暂时不可用，请稍后重试";
}

const service = createTimetableService({ database, now: () => new Date() });

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  try {
    switch (event.action) {
      case "get": return success(await service.get(OPENID));
      case "saveEntry": return success(await service.saveEntry(OPENID, event), "课程已保存");
      case "removeEntry": return success(await service.removeEntry(OPENID, event), "课程已删除");
      case "mergeEntries": return success(await service.mergeEntries(OPENID, event), "课程表已更新");
      default: return failure("不支持的操作");
    }
  } catch (error) {
    console.error("Timetable action failed", {
      action: event.action,
      code: Object.hasOwn(ERROR_MESSAGES, error && error.message) ? error.message : "INTERNAL",
    });
    return failure(publicErrorMessage(error));
  }
};

exports.createTimetableService = createTimetableService;
