const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadHomeworkFunction(options = {}) {
  const sourcePath = path.resolve(__dirname, "../cloudfunctions/homework/index.js");
  let documents = new Map((options.homework || []).map((item) => [item._id, structuredClone(item)]));
  let transactionQueue = Promise.resolve();
  let transactionAttempts = 0;
  let replayNextTransaction = options.replayFirstTransaction === true;
  let addCounter = 0;
  const user = {
    _id: "user-id",
    openid: "openid-id",
    familyId: "family-id",
    role: "creator",
    relation: "father",
    nickname: "家长",
  };

  function missingDocument() {
    const error = new Error("document does not exist");
    error.code = "DOCUMENT_NOT_FOUND";
    return error;
  }

  function collection(name, storage) {
    if (name === "users") {
      return {
        where(query) {
          return { limit() { return { async get() {
            return { data: query.openid === user.openid ? [{ ...user }] : [] };
          } }; } };
        },
      };
    }
    if (name === "homework") {
      return {
        doc(id) {
          return {
            async get() {
              if (!storage.has(id)) throw missingDocument();
              return { data: { ...structuredClone(storage.get(id)), _id: id } };
            },
            async set({ data }) { storage.set(id, structuredClone(data)); },
            async update({ data }) { storage.set(id, { ...storage.get(id), ...structuredClone(data) }); },
          };
        },
        async add({ data }) {
          addCounter += 1;
          const id = `manual-${addCounter}`;
          storage.set(id, structuredClone(data));
          return { _id: id };
        },
        where(query) {
          let items = [...storage.entries()]
            .map(([id, value]) => ({ _id: id, ...structuredClone(value) }))
            .filter((item) => Object.entries(query).every(([key, value]) => item[key] === value));
          let offset = 0;
          let limitValue = items.length;
          const chain = {
            async count() { return { total: items.length }; },
            orderBy(field, direction) {
              items = [...items].sort((left, right) => {
                const leftValue = new Date(left[field]).getTime();
                const rightValue = new Date(right[field]).getTime();
                return direction === "desc" ? rightValue - leftValue : leftValue - rightValue;
              });
              return chain;
            },
            skip(value) { offset = value; return chain; },
            limit(value) { limitValue = value; return chain; },
            async get() { return { data: items.slice(offset, offset + limitValue) }; },
          };
          return chain;
        },
      };
    }
    throw new Error(`测试未实现集合：${name}`);
  }

  const database = {
    collection(name) { return collection(name, documents); },
    RegExp({ regexp, options: flags }) { return new RegExp(regexp, flags); },
    async runTransaction(callback) {
      const result = transactionQueue.then(async () => {
        if (replayNextTransaction) {
          replayNextTransaction = false;
          transactionAttempts += 1;
          const discarded = structuredClone(documents);
          await callback({ collection: (name) => collection(name, discarded) });
        }
        transactionAttempts += 1;
        const staged = structuredClone(documents);
        const value = await callback({ collection: (name) => collection(name, staged) });
        documents = staged;
        return value;
      });
      transactionQueue = result.catch(() => {});
      return result;
    },
  };
  const moduleValue = { exports: {} };
  const context = vm.createContext({
    console: { error() {} },
    Date,
    module: moduleValue,
    exports: moduleValue.exports,
    require(request) {
      if (request === "crypto") return require("node:crypto");
      if (request === "wx-server-sdk") {
        return {
          DYNAMIC_CURRENT_ENV: "test",
          init() {},
          database() { return database; },
          getWXContext() { return { OPENID: user.openid }; },
        };
      }
      throw new Error(`测试未实现依赖：${request}`);
    },
  });
  vm.runInContext(fs.readFileSync(sourcePath, "utf8"), context, { filename: sourcePath });
  return {
    main: moduleValue.exports.main,
    getDocuments: () => documents,
    getTransactionAttempts: () => transactionAttempts,
  };
}

function createInput(overrides = {}) {
  return {
    action: "create",
    semester: "2026下",
    subject: "数学",
    title: "完成练习册",
    content: "第 20 页",
    extraRequirement: "订正错题",
    isImportant: false,
    hasDeadline: false,
    deadline: null,
    images: [],
    videos: [],
    links: [],
    extraTags: [],
    ...overrides,
  };
}

test("相同创建请求编号并发重试只生成一条作业", async () => {
  const fixture = loadHomeworkFunction();
  const input = createInput({ requestId: "0123456789abcdef0123456789abcdef_0" });

  const [first, second] = await Promise.all([fixture.main(input), fixture.main(input)]);

  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(first.data.id, second.data.id);
  assert.equal([first.data.created, second.data.created].filter(Boolean).length, 1);
  assert.equal(fixture.getDocuments().size, 1);
});

test("作业日期独立保存且长主题不会被截断", async () => {
  const fixture = loadHomeworkFunction();
  const title = "完整作业原文".repeat(20);
  const result = await fixture.main(createInput({ homeworkDate: "2026-09-14", title, content: "" }));
  assert.equal(result.success, true);
  const saved = fixture.getDocuments().get(result.data.id);
  assert.equal(saved.homeworkDate, "2026-09-14");
  assert.equal(saved.title, title);
  assert.equal(saved.content, "");
  assert.equal(saved.deadline, null);
});

test("非法作业日期和超长主题在写入前被拒绝", async () => {
  const fixture = loadHomeworkFunction();
  for (const homeworkDate of ["", "2026-02-29", "2026-09-31", "2026-9-14", "2026-09-14T00:00:00Z", 20260914]) {
    const result = await fixture.main(createInput({ homeworkDate }));
    assert.equal(result.success, false);
    assert.match(result.message, /作业日期/);
  }
  const tooLong = await fixture.main(createInput({ title: "题".repeat(501) }));
  assert.equal(tooLong.success, false);
  assert.match(tooLong.message, /500/);
  assert.equal(fixture.getDocuments().size, 0);
});

test("旧客户端新增默认今天且编辑不覆盖日期或补猜历史日期", async () => {
  const fixture = loadHomeworkFunction({ homework: [{
    _id: "legacy", familyId: "family-id", semester: "2026下", subject: "数学", title: "历史作业",
  }] });
  const first = await fixture.main(createInput());
  const beijingDate = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  assert.equal(fixture.getDocuments().get(first.data.id).homeworkDate, beijingDate);
  const second = await fixture.main(createInput({ homeworkDate: "2026-09-14" }));
  const edit = await fixture.main(createInput({ action: "update", id: second.data.id }));
  assert.equal(edit.success, true);
  assert.equal(fixture.getDocuments().get(second.data.id).homeworkDate, "2026-09-14");
  const legacy = await fixture.main(createInput({ action: "update", id: "legacy" }));
  assert.equal(legacy.success, true);
  assert.equal(fixture.getDocuments().get("legacy").homeworkDate, undefined);
});

test("创建请求编号重试时返回原作业且不覆盖已保存内容", async () => {
  const fixture = loadHomeworkFunction();
  const requestId = "0123456789abcdef0123456789abcdef_1";
  const first = await fixture.main(createInput({ requestId }));
  const second = await fixture.main(createInput({ requestId, title: "重试时修改的主题" }));

  assert.equal(first.data.id, second.data.id);
  assert.equal(second.data.created, false);
  assert.equal(fixture.getDocuments().get(first.data.id).title, "完成练习册");
});

test("非法创建请求编号在写入前被拒绝且普通创建保持原行为", async () => {
  const fixture = loadHomeworkFunction();
  const invalid = await fixture.main(createInput({ requestId: "too-short" }));
  assert.equal(invalid.success, false);
  assert.equal(invalid.message, "创建请求编号不正确");
  assert.equal(fixture.getDocuments().size, 0);

  const first = await fixture.main(createInput());
  const second = await fixture.main(createInput());
  assert.notEqual(first.data.id, second.data.id);
  assert.equal(fixture.getDocuments().size, 2);
});

test("事务冲突重放回调后不会残留丢弃尝试的创建结果", async () => {
  const fixture = loadHomeworkFunction({ replayFirstTransaction: true });

  const result = await fixture.main(createInput({ requestId: "0123456789abcdef0123456789abcdef_2" }));

  assert.equal(result.success, true);
  assert.equal(result.data.created, true);
  assert.equal(fixture.getTransactionAttempts(), 2);
  assert.equal(fixture.getDocuments().size, 1);
  assert.equal(fixture.getDocuments().has(result.data.id), true);
});

test("最近创建排序会包含最新已完成作业且拒绝未知排序模式", async () => {
  const oldItems = Array.from({ length: 50 }, (_, index) => ({
    _id: `old-${index}`,
    familyId: "family-id",
    semester: "2026下",
    subject: "数学",
    title: `旧作业 ${index}`,
    isCompleted: false,
    createdAt: new Date(`2026-09-${String((index % 9) + 1).padStart(2, "0")}T08:00:00.000Z`),
    createdBy: "openid-id",
  }));
  const latest = {
    _id: "latest-completed",
    familyId: "family-id",
    semester: "2026下",
    subject: "语文",
    title: "最新已完成作业",
    isCompleted: true,
    createdAt: new Date("2026-09-13T08:00:00.000Z"),
    createdBy: "openid-id",
  };
  const fixture = loadHomeworkFunction({ homework: [...oldItems, latest] });

  const result = await fixture.main({
    action: "list",
    semester: "2026下",
    page: 1,
    pageSize: 50,
    sortMode: "created_at_desc",
  });

  assert.equal(result.success, true);
  assert.equal(result.data.items.length, 50);
  assert.equal(result.data.items[0]._id, "latest-completed");
  assert.equal(result.data.items[0].createdBy, undefined);

  const invalid = await fixture.main({ action: "list", sortMode: "deadline_desc" });
  assert.equal(invalid.success, false);
  assert.equal(invalid.message, "排序方式不正确");
});
