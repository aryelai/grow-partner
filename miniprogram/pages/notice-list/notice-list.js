const { callFunction, showError } = require("../../utils/api");
const { requireFamily } = require("../../utils/session");
const { NOTICE_CATEGORIES } = require("../../utils/constants");
const { formatDateTime } = require("../../utils/date");

const categories = [{ value: "all", label: "全部" }, ...NOTICE_CATEGORIES];

Page({
  data: { categories, category: "all", keyword: "", semester: "2026下", items: [], page: 1, hasMore: false, loading: true },
  async onShow() {
    const session = await requireFamily();
    if (!session) return;
    this.setData({ semester: session.family.currentSemester });
    await this.load(true);
  },
  onPullDownRefresh() { this.load(true).finally(() => wx.stopPullDownRefresh()); },
  onReachBottom() { if (this.data.hasMore && !this.data.loading) this.load(false); },
  async load(reset) {
    const page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true });
    try {
      const data = await callFunction("notice", "list", { semester: this.data.semester, category: this.data.category, keyword: this.data.keyword, page, pageSize: 20 });
      const items = data.items.map((item) => ({ ...item, categoryName: (NOTICE_CATEGORIES.find((category) => category.value === item.category) || {}).label || "其他", createdAtText: formatDateTime(item.createdAt) }));
      this.setData({ items: reset ? items : [...this.data.items, ...items], page, hasMore: data.hasMore });
    } catch (error) { showError(error, "通知加载失败"); }
    finally { this.setData({ loading: false }); }
  },
  selectCategory(event) { this.setData({ category: event.currentTarget.dataset.value }); this.load(true); },
  onSearchInput(event) { clearTimeout(this.searchTimer); this.setData({ keyword: event.detail.value }); this.searchTimer = setTimeout(() => this.load(true), 300); },
  create() { wx.navigateTo({ url: "/pages/notice-edit/notice-edit" }); },
  edit(event) { wx.navigateTo({ url: `/pages/notice-edit/notice-edit?id=${event.currentTarget.dataset.id}` }); },
  onUnload() { clearTimeout(this.searchTimer); },
});
