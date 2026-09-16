const SHARE_TITLE = "尹尹成长搭档";
const SHARE_CARD_IMAGE_URL = "/images/share-card.png";
const SHARE_TIMELINE_IMAGE_URL = "/images/share-timeline.png";

function createShareAppMessage() {
  return {
    title: SHARE_TITLE,
    path: "/pages/home/home",
    imageUrl: SHARE_CARD_IMAGE_URL,
  };
}

function createShareTimelineMessage() {
  return {
    title: SHARE_TITLE,
    query: "",
    imageUrl: SHARE_TIMELINE_IMAGE_URL,
  };
}

module.exports = {
  createShareAppMessage,
  createShareTimelineMessage,
};
