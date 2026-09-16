// 路由注册保留在 app.json；运行时使用普通 JS 模块，避免把配置 JSON 当作脚本加载。
const MAIN_TABS = [
  { pagePath: "pages/home/home", text: "首页", icon: "home" },
  { pagePath: "pages/homework-list/homework-list", text: "作业", icon: "homework" },
  { pagePath: "pages/notice-list/notice-list", text: "通知", icon: "notice" },
  { pagePath: "pages/habit-list/habit-list", text: "成长", icon: "habit" },
  { pagePath: "pages/settings/settings", text: "我的", icon: "me" },
].map(({ pagePath, text, icon }) => ({ pagePath, text, iconPath: `images/tab/${icon}.png`, selectedIconPath: `images/tab/${icon}-active.png` }));

module.exports = { MAIN_TABS };
