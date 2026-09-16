const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const {
  createHomeDateContext,
  createScheduleOverview,
  createPlanOverview,
  createHabitOverview,
} = require("../miniprogram/utils/home");

const projectRoot = path.resolve(__dirname, "..");

function readPngInkBounds(file) {
  const source = fs.readFileSync(file);
  assert.equal(source.subarray(1, 4).toString("ascii"), "PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const dataChunks = [];
  while (offset < source.length) {
    const length = source.readUInt32BE(offset);
    const type = source.subarray(offset + 4, offset + 8).toString("ascii");
    const data = source.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8);
      colorType = data[9];
      assert.equal(data[12], 0);
    }
    if (type === "IDAT") dataChunks.push(data);
    offset += length + 12;
  }
  assert.equal(colorType, 6);
  const inflated = zlib.inflateSync(Buffer.concat(dataChunks));
  const rowLength = width * 4;
  const previous = Buffer.alloc(rowLength);
  const current = Buffer.alloc(rowLength);
  const bounds = { minX: width, minY: height, maxX: -1, maxY: -1 };
  let inputOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset];
    inputOffset += 1;
    for (let x = 0; x < rowLength; x += 1) {
      const raw = inflated[inputOffset + x];
      const left = x >= 4 ? current[x - 4] : 0;
      const up = previous[x];
      const upperLeft = x >= 4 ? previous[x - 4] : 0;
      let value = raw;
      if (filter === 1) value = (raw + left) & 255;
      else if (filter === 2) value = (raw + up) & 255;
      else if (filter === 3) value = (raw + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) {
        const prediction = left + up - upperLeft;
        const leftDistance = Math.abs(prediction - left);
        const upDistance = Math.abs(prediction - up);
        const upperLeftDistance = Math.abs(prediction - upperLeft);
        const predictor = leftDistance <= upDistance && leftDistance <= upperLeftDistance
          ? left : upDistance <= upperLeftDistance ? up : upperLeft;
        value = (raw + predictor) & 255;
      }
      current[x] = value;
    }
    for (let x = 0; x < width; x += 1) {
      const red = current[x * 4];
      const green = current[x * 4 + 1];
      const blue = current[x * 4 + 2];
      const alpha = current[x * 4 + 3];
      if (alpha === 0 || (red >= 245 && green >= 245 && blue >= 245)) continue;
      bounds.minX = Math.min(bounds.minX, x);
      bounds.maxX = Math.max(bounds.maxX, x);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxY = Math.max(bounds.maxY, y);
    }
    current.copy(previous);
    inputOffset += rowLength;
  }
  return { width, height, ...bounds };
}

test("首页日期始终按北京时间生成星期和问候语", () => {
  const context = createHomeDateContext(new Date("2026-09-14T16:30:00.000Z"));
  assert.equal(context.date, "2026-09-15");
  assert.equal(context.dateLabel, "9月15日");
  assert.equal(context.weekday, 2);
  assert.equal(context.weekdayLabel, "星期二");
  assert.equal(context.greeting, "早上好");
});

test("首页课程摘要优先展示正在进行或即将开始的课程", () => {
  const entries = [
    { dayOfWeek: 2, period: 1, courseName: "语文", startTime: "08:00", endTime: "08:40" },
    { dayOfWeek: 2, period: 2, courseName: "数学", startTime: "08:50", endTime: "09:30" },
    { dayOfWeek: 2, period: 3, courseName: "英语", startTime: "10:00", endTime: "10:40" },
    { dayOfWeek: 3, period: 1, courseName: "历史", startTime: "08:00", endTime: "08:40" },
  ];

  const current = createScheduleOverview(entries, new Date("2026-09-15T01:00:00.000Z"));
  assert.equal(current.focus.courseName, "数学");
  assert.equal(current.stateText, "正在上课");
  assert.deepEqual(current.following.map((item) => item.courseName), ["英语"]);

  const next = createScheduleOverview(entries, new Date("2026-09-15T00:42:00.000Z"));
  assert.equal(next.focus.courseName, "数学");
  assert.equal(next.stateText, "08:50 开始");
});

test("首页计划与习惯摘要按公开状态计算进度", () => {
  const plan = createPlanOverview([
    { items: [{ text: "整理书包", isDone: true }, { text: "晚间复盘", isDone: false }] },
    { items: [{ text: "阅读", isDone: true }] },
  ]);
  assert.deepEqual(plan, { total: 3, done: 2, percentage: 67, pendingText: "晚间复盘" });

  const habits = createHabitOverview([
    { _id: "1", name: "阅读", streak: 5 },
    { _id: "2", name: "运动", streak: 0 },
  ]);
  assert.equal(habits.total, 2);
  assert.equal(habits.done, 1);
  assert.equal(habits.items[0].completedToday, true);
  assert.equal(habits.items[1].completedToday, false);
});

test("小程序采用首页、作业、通知、成长、我的五入口导航", () => {
  const appConfig = JSON.parse(fs.readFileSync(path.join(projectRoot, "miniprogram/app.json"), "utf8"));
  assert.equal(appConfig.pages[0], "pages/home/home");
  assert.deepEqual(appConfig.tabBar.list.map((item) => [item.pagePath, item.text]), [
    ["pages/home/home", "首页"],
    ["pages/homework-list/homework-list", "作业"],
    ["pages/notice-list/notice-list", "通知"],
    ["pages/habit-list/habit-list", "成长"],
    ["pages/settings/settings", "我的"],
  ]);
});

test("底部导航图标在透明画布内保持足够尺寸并居中", () => {
  const iconDirectory = path.join(projectRoot, "miniprogram/images/tab");
  for (const name of ["home", "homework", "notice", "habit", "me"]) {
    for (const suffix of ["", "-active"]) {
      const bounds = readPngInkBounds(path.join(iconDirectory, `${name}${suffix}.png`));
      const visibleWidth = bounds.maxX - bounds.minX + 1;
      const visibleHeight = bounds.maxY - bounds.minY + 1;
      assert.equal(bounds.width, 96);
      assert.equal(bounds.height, 96);
      assert.ok(visibleWidth >= 56 && visibleWidth <= 76, `${name}${suffix} 可见宽度为 ${visibleWidth}`);
      assert.ok(visibleHeight >= 56 && visibleHeight <= 76, `${name}${suffix} 可见高度为 ${visibleHeight}`);
      assert.ok(Math.abs(bounds.minX - (96 - bounds.maxX - 1)) <= 3, `${name}${suffix} 水平未居中`);
      assert.ok(Math.abs(bounds.minY - (96 - bounds.maxY - 1)) <= 3, `${name}${suffix} 垂直未居中`);
    }
  }
});

test("首页全天课程上午下午各四节且不因当前时间截断", () => {
  const entries = Array.from({ length: 8 }, (_, index) => ({
    dayOfWeek: 2, period: index + 1, courseName: `课程${index + 1}`,
    startTime: index < 4 ? `0${8 + Math.floor(index / 2)}:${index % 2 ? '50' : '00'}` : `1${4 + Math.floor((index - 4) / 2)}:${index % 2 ? '50' : '00'}`,
    endTime: index < 4 ? `0${8 + Math.floor(index / 2)}:${index % 2 ? '59' : '40'}` : `1${4 + Math.floor((index - 4) / 2)}:${index % 2 ? '59' : '40'}`,
  }));
  const schedule = createScheduleOverview(entries, new Date("2026-09-15T07:00:00.000Z"));
  assert.equal(schedule.total, 8);
  assert.deepEqual(schedule.sessions.map((session) => session.items.length), [4, 4]);
  assert.deepEqual(schedule.sessions.flatMap((session) => session.items).map((entry) => entry.period), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(schedule.sessions.flatMap((session) => session.items).filter((entry) => entry.isCurrent).length, 1);
});

test("首页课程缺时间按节次分组且实际十节全部保留", () => {
  const schedule = createScheduleOverview(Array.from({ length: 10 }, (_, index) => ({ dayOfWeek: 2, period: index + 1, courseName: "待补时间课程" })), new Date("2026-09-15T14:00:00.000Z"));
  assert.equal(schedule.total, 10);
  assert.equal(schedule.sessions.flatMap((session) => session.items).length, 10);
  assert.equal(schedule.sessions[0].items.length, 4);
  assert.equal(schedule.sessions[1].items.length, 6);
  assert.ok(schedule.sessions.flatMap((session) => session.items).every((entry) => entry.timeText === "时间待补充" && !entry.isCurrent));
  const empty = createScheduleOverview([], new Date("2026-09-15T14:00:00.000Z"));
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.sessions, []);
});

test("首页和我的页面保留课程表与完整计划入口", () => {
  const homeTemplate = fs.readFileSync(path.join(projectRoot, "miniprogram/pages/home/home.wxml"), "utf8");
  const settingsTemplate = fs.readFileSync(path.join(projectRoot, "miniprogram/pages/settings/settings.wxml"), "utf8");
  for (const source of [homeTemplate, settingsTemplate]) {
    assert.match(source, /课程表/);
    assert.match(source, /计划/);
  }
  assert.match(homeTemplate, /待完成作业/);
  assert.match(homeTemplate, /重要通知/);
  assert.match(homeTemplate, /快捷处理/);
});

test("分享、登录和家庭创建完成后都进入可浏览首页", () => {
  const shareSource = fs.readFileSync(path.join(projectRoot, "miniprogram/utils/share.js"), "utf8");
  const loginSource = fs.readFileSync(path.join(projectRoot, "miniprogram/pages/login/login.js"), "utf8");
  const familySource = fs.readFileSync(path.join(projectRoot, "miniprogram/pages/family-create/family-create.js"), "utf8");
  assert.match(shareSource, /path: "\/pages\/home\/home"/);
  assert.equal((loginSource.match(/\/pages\/home\/home/g) || []).length, 2);
  assert.match(familySource, /\/pages\/home\/home/);
});
