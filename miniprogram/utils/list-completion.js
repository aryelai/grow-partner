const { canPerform } = require("./permissions");
const { setGuestCompletion } = require("./guest-state");

function createListCompletion({ kind, permission, callFunction, showError, reload, itemKey = "items" }) {
  async function update(page, id, isCompleted) {
    if (page.data.guestMode) setGuestCompletion(kind, id, isCompleted);
    else await callFunction(kind, "toggleCompleted", { id, isCompleted });
    await reload.call(page);
  }

  return {
    async toggle(event) {
      if (this.data.completionBusy || this.data.loading) return;
      const item = (this.data[itemKey] || []).find((entry) => entry._id === event.currentTarget.dataset.id);
      if (!item || (!this.data.guestMode && !canPerform(this.currentUser && this.currentUser.role, permission))) return;
      this.setData({ completionBusy: true });
      try {
        await update(this, item._id, item.isCompleted !== true);
        this.completionUndo = { id: item._id, previous: item.isCompleted === true };
        this.setData({ undoId: item._id, completionText: item.isCompleted ? "已恢复待完成" : "已标为完成" });
      } catch (error) {
        showError(error, "完成状态更新失败，请重试");
      } finally {
        this.setData({ completionBusy: false });
      }
    },
    async undo() {
      const record = this.completionUndo;
      if (!record || this.data.completionBusy || this.data.loading) return;
      if (!this.data.guestMode && !canPerform(this.currentUser && this.currentUser.role, permission)) return;
      this.setData({ completionBusy: true });
      try {
        await update(this, record.id, record.previous);
        this.completionUndo = null;
        this.setData({ undoId: "" });
      } catch (error) {
        showError(error, "撤销失败，请重试");
      } finally {
        this.setData({ completionBusy: false });
      }
    },
    dismiss() {
      this.completionUndo = null;
      this.setData({ undoId: "" });
    },
  };
}

module.exports = { createListCompletion };
