const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadHomeworkFunction(options = {}) {
  const sourcePath = path.resolve(__dirname, "../cloudfunctions/homework/index.js");
  let documents = new Map();
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
              return { data: structuredClone(storage.get(id)) };
            },
            async set({ data }) { storage.set(id, structuredClone(data)); },
          };
        },
        async add({ data }) {
          addCounter += 1;
          const id = `manual-${addCounter}`;
          storage.set(id, structuredClone(data));
          return { _id: id };
        },
      };
    }
    throw new Error(`测试未实现集合：${name}`);
  }

  const database = {
    collection(name) { return collection(name, documents); },
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
