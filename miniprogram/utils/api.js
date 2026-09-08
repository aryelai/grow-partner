function callFunction(name, action, data = {}) {
  return wx.cloud.callFunction({
    name,
    data: { action, ...data },
  }).then(({ result }) => {
    if (!result || result.success !== true) {
      const error = new Error(result && result.message ? result.message : "请求失败，请稍后重试");
      error.code = result && result.code ? result.code : "UNKNOWN";
      throw error;
    }
    return result.data;
  }).catch((error) => {
    console.error("Cloud function request failed", { name, action, message: error.message });
    throw error;
  });
}

function showError(error, fallback = "操作失败，请稍后重试") {
  wx.showToast({
    title: error && error.message ? error.message : fallback,
    icon: "none",
  });
}

function uploadFile(cloudPath, filePath) {
  return wx.cloud.uploadFile({ cloudPath, filePath }).then((result) => result.fileID);
}

module.exports = { callFunction, showError, uploadFile };
