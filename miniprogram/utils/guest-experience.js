const { formatDate, formatDateTime, getCurrentSemester, getDateRangeForPlan, getBeijingDate, formatHomeworkDate } = require("./date");

const GUEST_SEMESTER_LABEL = "功能演示";

function addDays(baseDate, offset) {
  const date = new Date(baseDate);
  date.setDate(date.getDate() + offset);
  return date;
}

function cloneItems(items) {
  return items.map((item) => ({
    ...item,
    ...(Array.isArray(item.items) ? { items: item.items.map((entry) => ({ ...entry })) } : {}),
    ...(Array.isArray(item.checkInItems) ? { checkInItems: item.checkInItems.map((entry) => ({ ...entry })) } : {}),
    ...(Array.isArray(item.extraTags) ? { extraTags: item.extraTags.slice() } : {}),
    ...(Array.isArray(item.images) ? { images: item.images.slice() } : {}),
    ...(Array.isArray(item.videos) ? { videos: item.videos.slice() } : {}),
    ...(Array.isArray(item.links) ? { links: item.links.slice() } : {}),
  }));
}

function normalizeKeyword(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function createGuestHomeworkItems(options = {}, now = new Date()) {
  const tomorrow = addDays(now, 1);
  tomorrow.setHours(20, 0, 0, 0);
  const homeworkDate = getBeijingDate(now);
  const items = [
    {
      _id: "guest-homework-math",
      semester: getCurrentSemester(now),
      subject: "数学",
      title: "完成课本第18页练习",
      content: "完成第1—6题，订正错题并写出计算过程。",
      extraRequirement: "家长检查",
      extraTags: ["练习", "需检查"],
      createdByName: "示例家长",
      isImportant: true,
      isCompleted: false,
      hasDeadline: true,
      deadline: tomorrow.toISOString(),
      deadlineText: formatDateTime(tomorrow),
      isOverdue: false,
      images: [],
      videos: [],
      links: [],
    },
    {
      _id: "guest-homework-chinese",
      semester: getCurrentSemester(now),
      subject: "语文",
      title: "背诵《春》第二、三段",
      content: "熟读课文，完成课后生字词整理。",
      extraRequirement: "",
      extraTags: ["背诵"],
      createdByName: "示例家长",
      isImportant: false,
      isCompleted: false,
      hasDeadline: false,
      deadline: "",
      deadlineText: "",
      isOverdue: false,
      images: [],
      videos: [],
      links: [],
    },
    {
      _id: "guest-homework-english",
      semester: getCurrentSemester(now),
      subject: "英语",
      title: "完成单词听写订正",
      content: "订正本周听写错词，每个单词抄写三遍。",
      extraRequirement: "",
      extraTags: ["订正"],
      createdByName: "示例家长",
      isImportant: false,
      isCompleted: true,
      hasDeadline: false,
      deadline: "",
      deadlineText: "",
      isOverdue: false,
      images: [],
      videos: [],
      links: [],
    },
  ];
  const subject = typeof options.subject === "string" ? options.subject : "全部";
  const status = typeof options.status === "string" ? options.status : "all";
  const keyword = normalizeKeyword(options.keyword);
  return cloneItems(items.map((item) => ({ ...item, homeworkDate, homeworkDateText: formatHomeworkDate(homeworkDate), homeworkDateMissing: false })).filter((item) => (
    (subject === "全部" || item.subject === subject)
    && (status === "all" || (status === "completed" ? item.isCompleted : !item.isCompleted))
    && (!keyword || `${item.title} ${item.content} ${item.subject}`.toLowerCase().includes(keyword))
  )));
}

function createGuestNoticeItems(options = {}, now = new Date()) {
  const items = [
    {
      _id: "guest-notice-exam",
      title: "本周五数学阶段考试",
      content: "请准备直尺、铅笔和橡皮，提前复习第一、二单元。",
      category: "exam",
      categoryName: "考试",
      source: "班级通知示例",
      createdAtText: formatDateTime(addDays(now, -1)),
      remindTime: addDays(now, 2).toISOString(),
    },
    {
      _id: "guest-notice-activity",
      title: "校园阅读活动报名",
      content: "有意参加的同学请在周三前确认，活动安排以班级后续通知为准。",
      category: "activity",
      categoryName: "活动",
      source: "班级通知示例",
      createdAtText: formatDateTime(addDays(now, -2)),
      remindTime: "",
    },
    {
      _id: "guest-notice-other",
      title: "明日请携带美术材料",
      content: "需要准备彩纸、剪刀和胶棒，并在用品上写好姓名。",
      category: "other",
      categoryName: "其他",
      source: "任课老师示例",
      createdAtText: formatDateTime(now),
      remindTime: "",
    },
  ];
  const category = typeof options.category === "string" ? options.category : "all";
  const keyword = normalizeKeyword(options.keyword);
  return cloneItems(items.filter((item) => (
    (category === "all" || item.category === category)
    && (!keyword || `${item.title} ${item.content} ${item.source}`.toLowerCase().includes(keyword))
  )));
}

function createGuestHabitItems(category = "behavior") {
  const items = [
    {
      _id: "guest-habit-posture",
      category: "behavior",
      categoryIcon: "行",
      name: "坐姿与体态提醒",
      description: "靠墙站立5分钟 + 背部拉伸操3组",
      checkInSummary: "靠墙站立5分钟 + 背部拉伸操3组",
      streak: 6,
      completedDays: 12,
      targetDays: 30,
      progress: 40,
      checkInItems: [{ name: "靠墙站立5分钟" }, { name: "背部拉伸操3组" }],
    },
    {
      _id: "guest-habit-sleep",
      category: "life",
      categoryIcon: "生",
      name: "按时整理书包",
      description: "睡前核对次日课程和学习用品",
      checkInSummary: "核对课程表 + 整理学习用品",
      streak: 9,
      completedDays: 15,
      targetDays: 21,
      progress: 71,
      checkInItems: [{ name: "核对课程表" }, { name: "整理学习用品" }],
    },
    {
      _id: "guest-habit-reading",
      category: "study",
      categoryIcon: "学",
      name: "每日阅读30分钟",
      description: "阅读后用一句话记录今天的收获",
      checkInSummary: "阅读30分钟 + 记录一句话",
      streak: 4,
      completedDays: 8,
      targetDays: 21,
      progress: 38,
      checkInItems: [{ name: "阅读30分钟" }, { name: "记录一句话" }],
    },
  ];
  return cloneItems(items.filter((item) => item.category === category));
}

function createGuestPlanState(type = "daily", anchorDate = formatDate(new Date())) {
  const range = getDateRangeForPlan(type, anchorDate);
  const titles = { daily: "今日放学后安排", weekly: "本周学习重点", monthly: "本月成长目标" };
  const taskSets = {
    daily: [
      { text: "整理当天作业清单", isDone: true, priority: "high" },
      { text: "完成数学练习并订正", isDone: false, priority: "high" },
      { text: "阅读30分钟", isDone: false, priority: "medium" },
    ],
    weekly: [
      { text: "复习数学第一、二单元", isDone: true, priority: "high" },
      { text: "整理英语错词本", isDone: false, priority: "medium" },
      { text: "完成一次体育锻炼", isDone: false, priority: "low" },
    ],
    monthly: [
      { text: "连续阅读21天", isDone: false, priority: "high" },
      { text: "每周整理一次错题", isDone: true, priority: "medium" },
      { text: "独立整理学习用品", isDone: false, priority: "low" },
    ],
  };
  const items = [{
    _id: `guest-plan-${type}`,
    title: titles[type] || titles.daily,
    date: range.start,
    notes: "这是本地演示计划，勾选状态不会保存。",
    items: taskSets[type] || taskSets.daily,
  }];
  const allItems = items.flatMap((item) => item.items);
  const doneCount = allItems.filter((item) => item.isDone).length;
  return {
    items: cloneItems(items),
    completionRate: Math.round(doneCount * 100 / allItems.length),
  };
}

function requestFamilyAccess(message, wxApi) {
  if (!wxApi) throw new Error("Missing WeChat API for family access request");
  wxApi.showModal({
    title: "使用家庭功能",
    content: message || "登录并加入家庭后，才会读取和保存你的家庭数据。",
    confirmText: "去登录",
    cancelText: "继续体验",
    success(result) {
      if (result.confirm) wxApi.navigateTo({ url: "/pages/login/login" });
    },
  });
}

module.exports = {
  GUEST_SEMESTER_LABEL,
  createGuestHomeworkItems,
  createGuestNoticeItems,
  createGuestHabitItems,
  createGuestPlanState,
  requestFamilyAccess,
};
