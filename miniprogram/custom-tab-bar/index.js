const { MAIN_TABS } = require("../utils/navigation");

Component({
  data: { selected: 0, switching: false, tabs: MAIN_TABS },
  lifetimes: { attached() { this.syncSelection(); }, ready() { this.syncSelection(); } },
  pageLifetimes: { show() { this.syncSelection(); } },
  methods: {
    syncSelection() {
      const pages = getCurrentPages();
      const current = pages[pages.length - 1];
      if (!current) return;
      const selected = this.data.tabs.findIndex((item) => item.pagePath === current.route);
      if (selected >= 0) this.setData({ selected });
    },
    switchTab(event) {
      const index = Number(event.currentTarget.dataset.index);
      if (!Number.isInteger(index) || !this.data.tabs[index] || this.data.switching || index === this.data.selected) return;
      this.setData({ switching: true });
      wx.switchTab({
        url: `/${this.data.tabs[index].pagePath}`,
        success: () => this.setData({ selected: index }),
        fail: (error) => {
          console.error("Switch main tab failed", { index, code: error && error.errCode });
          wx.showToast({ title: "页面切换失败，请重试", icon: "none" });
        },
        complete: () => this.setData({ switching: false }),
      });
    },
  },
});
