const EDUCATION_STAGES = [
  { value: "kindergarten", label: "幼儿园" },
  { value: "primary", label: "小学" },
  { value: "junior_high", label: "初中" },
  { value: "senior_high", label: "高中" },
];

const GRADES = {
  kindergarten: ["小班", "中班", "大班"],
  primary: ["1", "2", "3", "4", "5", "6"],
  junior_high: ["1", "2", "3"],
  senior_high: ["1", "2", "3"],
};

const RELATIONS = {
  father: "爸爸",
  mother: "妈妈",
  grandpa_paternal: "爷爷",
  grandma_paternal: "奶奶",
  grandpa_maternal: "外公",
  grandma_maternal: "外婆",
  uncle_paternal: "叔叔",
  aunt_paternal: "婶婶",
  uncle_maternal: "舅舅",
  aunt_maternal: "舅妈",
  brother: "哥哥",
  sister: "姐姐",
  child: "孩子",
};

const DEFAULT_SUBJECTS = {
  kindergarten: ["语言", "数学启蒙", "英语启蒙", "科学", "艺术", "体育", "社会"],
  primary: ["语文", "数学", "英语", "科学", "道德与法治", "音乐", "美术", "体育", "信息技术", "劳动"],
  junior_high: ["语文", "数学", "英语", "物理", "化学", "生物", "道德与法治", "历史", "地理", "音乐", "美术", "体育", "信息技术", "劳动技术"],
  senior_high: ["语文", "数学", "英语", "物理", "化学", "生物", "政治", "历史", "地理", "音乐", "美术", "体育", "通用技术", "信息技术"],
};

const NOTICE_CATEGORIES = [
  { value: "flag_raising", label: "升旗" },
  { value: "exam", label: "考试" },
  { value: "activity", label: "活动" },
  { value: "homework", label: "作业" },
  { value: "other", label: "其他" },
];

const HABIT_CATEGORIES = [
  { value: "behavior", label: "行为习惯" },
  { value: "life", label: "生活习惯" },
  { value: "study", label: "学习习惯" },
];

const PLAN_TYPES = [
  { value: "daily", label: "日" },
  { value: "weekly", label: "周" },
  { value: "monthly", label: "月" },
];

const PRIORITIES = [
  { value: "high", label: "高" },
  { value: "medium", label: "中" },
  { value: "low", label: "低" },
];

const CURRENT_SEMESTER = "2026下";

module.exports = {
  EDUCATION_STAGES,
  GRADES,
  RELATIONS,
  DEFAULT_SUBJECTS,
  NOTICE_CATEGORIES,
  HABIT_CATEGORIES,
  PLAN_TYPES,
  PRIORITIES,
  CURRENT_SEMESTER,
};
