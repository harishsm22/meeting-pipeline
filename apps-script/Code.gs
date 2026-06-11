// Google Apps Script: pushes your upcoming calendar events to the
// meeting-pipeline worker every 15 minutes.
//
// Setup (one time):
//   1. Go to script.google.com -> New project
//   2. Delete the placeholder code, paste this entire file
//   3. Fill in APP_SECRET below (same one you set in Cloudflare)
//   4. Click "Run" once (function: pushEvents) -> approve the permission
//      prompts (it only reads your own calendar)
//   5. Left sidebar: Triggers (clock icon) -> Add Trigger ->
//      function: pushEvents | event source: Time-driven |
//      type: Minutes timer | every 15 minutes -> Save

const WORKER_URL = "https://meeting-pipeline.harish-46d.workers.dev";
const APP_SECRET = "PASTE_YOUR_APP_SECRET_HERE";

function pushEvents() {
  const now = new Date();
  const from = new Date(now.getTime() - 6 * 3600 * 1000);
  const to = new Date(now.getTime() + 18 * 3600 * 1000);

  const events = CalendarApp.getDefaultCalendar()
    .getEvents(from, to)
    .map(function (e) {
      const guests = e.getGuestList(true).map(function (g) {
        const name = g.getName();
        return name && name.indexOf("@") === -1
          ? name + " <" + g.getEmail() + ">"
          : g.getEmail();
      });
      return {
        title: e.getTitle(),
        start: e.getStartTime().toISOString(),
        attendees: guests.join(", "),
      };
    });

  const response = UrlFetchApp.fetch(WORKER_URL + "/calendar-push", {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + APP_SECRET },
    payload: JSON.stringify({ events: events }),
    muteHttpExceptions: true,
  });

  Logger.log("Pushed " + events.length + " events: " + response.getContentText());
}
