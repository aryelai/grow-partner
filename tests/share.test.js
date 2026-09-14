const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "..");
const miniprogramRoot = path.join(projectRoot, "miniprogram");
const appConfig = JSON.parse(fs.readFileSync(path.join(miniprogramRoot, "app.json"), "utf8"));

test("所有已注册页面都启用统一的好友和朋友圈分享回调", () => {
  for (const pagePath of appConfig.pages) {
    const scriptPath = path.join(miniprogramRoot, `${pagePath}.js`);
    const source = fs.readFileSync(scriptPath, "utf8");
    assert.match(source, /onShareAppMessage\s*:\s*createShareAppMessage/, `${pagePath} 缺少统一好友分享回调`);
    assert.match(source, /onShareTimeline\s*:\s*createShareTimelineMessage/, `${pagePath} 缺少统一朋友圈分享回调`);
  }
});

test("好友分享统一进入游客可访问的作业首页且不携带家庭数据", () => {
  const { createShareAppMessage } = require("../miniprogram/utils/share");
  const message = createShareAppMessage();

  assert.deepEqual(message, {
    title: "尹尹成长搭档",
    path: "/pages/homework-list/homework-list",
    imageUrl: "/images/share-card.png",
  });
  assert.doesNotMatch(JSON.stringify(message), /familyId|inviteCode|openid|recordId|[?&=]/i);
});

function readPngDimensions(imagePath) {
  const image = fs.readFileSync(imagePath);
  assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
}

test("好友分享封面存在且尺寸比例为 5:4", () => {
  const dimensions = readPngDimensions(path.join(miniprogramRoot, "images/share-card.png"));
  assert.deepEqual(dimensions, { width: 500, height: 400 });
});

test("朋友圈分享封面存在且尺寸比例为 1:1", () => {
  const dimensions = readPngDimensions(path.join(miniprogramRoot, "images/share-timeline.png"));
  assert.deepEqual(dimensions, { width: 400, height: 400 });
});

test("朋友圈分享使用安全通用内容且不携带查询参数", () => {
  const { createShareTimelineMessage } = require("../miniprogram/utils/share");
  const message = createShareTimelineMessage();

  assert.deepEqual(message, {
    title: "尹尹成长搭档",
    query: "",
    imageUrl: "/images/share-timeline.png",
  });
  assert.doesNotMatch(JSON.stringify(message), /familyId|inviteCode|openid|recordId|[?&=]/i);
});
