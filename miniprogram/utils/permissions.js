const CREATOR_ACTIONS = new Set([
  "view",
  "createHomework",
  "importHomework",
  "importNotice",
  "manageTimetable",
  "importTimetable",
  "updateHomework",
  "deleteHomework",
  "requestDeleteHomework",
  "toggleHomework",
  "updateHomeworkLearningState",
  "manageNotice",
  "manageHabit",
  "checkInHabit",
  "managePlan",
  "createOwnPlan",
  "togglePlan",
  "manageMembers",
  "updateFamily",
  "updateSettings",
  "manageAi",
]);

const MEMBER_ACTIONS = new Set([
  "view",
  "createHomework",
  "importHomework",
  "importNotice",
  "manageTimetable",
  "importTimetable",
  "updateHomework",
  "requestDeleteHomework",
  "toggleHomework",
  "updateHomeworkLearningState",
  "manageNotice",
  "manageHabit",
  "checkInHabit",
  "managePlan",
  "createOwnPlan",
  "togglePlan",
]);

const CHILD_ACTIONS = new Set(["view", "toggleHomework", "updateHomeworkLearningState", "checkInHabit", "createOwnPlan", "togglePlan"]);

function canPerform(role, action, context = {}) {
  if (role === "creator") {
    return CREATOR_ACTIONS.has(action);
  }
  if (role === "child") {
    return CHILD_ACTIONS.has(action);
  }
  if (role !== "member") {
    return false;
  }
  if (action === "deleteHomework") {
    return context.ownsResource === true;
  }
  if (action === "updateSettings") {
    return context.allowMemberEditSettings === true;
  }
  return MEMBER_ACTIONS.has(action);
}

module.exports = { canPerform };
