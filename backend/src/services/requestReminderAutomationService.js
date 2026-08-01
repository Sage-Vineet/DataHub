"use strict";

const { supabase } = require("../db");
const requestService = require("./requestService");
const { deliverRequestReminder } = require("./requestReminderDeliveryService");
const {
  isRequestOverdue,
  resolveNextReminderAt,
} = require("../utils/requestReminders");

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
let timer = null;
let running = false;

function reminderEventType(event) {
  return String(event?.event_type || "sent").trim().toLowerCase() || "sent";
}

function getCadenceBaseTime(event) {
  if (!event) return null;
  return event.scheduled_for || event.sent_at;
}

function groupByRequestId(events) {
  return (events || []).reduce((acc, event) => {
    if (!acc[event.request_id]) acc[event.request_id] = [];
    acc[event.request_id].push(event);
    return acc;
  }, {});
}

async function listAutomationCandidates(limit) {
  const { data, error } = await supabase
    .from("requests")
    .select(`
      *,
      company:companies(name, contact_name, contact_email, contact_phone)
    `)
    .eq("approval_status", "approved")
    .in("status", ["pending", "in-review", "blocked"])
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) throw error;
  return requestService.attachRequestAssignees(data || []);
}

async function listHistoryForRequests(requestIds) {
  if (!requestIds.length) return {};
  const { data, error } = await supabase
    .from("request_reminders")
    .select("*")
    .in("request_id", requestIds)
    .order("sent_at", { ascending: false });

  if (error) throw error;
  return groupByRequestId(data || []);
}

async function processReminderRequest(request, history, now) {
  const actorId = request.approved_by || request.created_by;
  if (!actorId) return { skipped: true, reason: "missing_actor" };

  const overdueNotice = history.find((event) => reminderEventType(event) === "overdue");
  if (isRequestOverdue(request, now)) {
    if (overdueNotice) return { skipped: true, reason: "overdue_notice_already_sent" };

    const sentAt = now.toISOString();
    await requestService.createReminderEvent(request.id, actorId, sentAt, {
      eventType: "overdue",
      metadata: { trigger: "automatic_overdue" },
    });
    await deliverRequestReminder({
      request,
      sentBy: actorId,
      sentAt,
      noticeType: "overdue",
      trigger: "automatic_overdue",
    });
    return { overdue: true };
  }

  if (String(request.status || "").toLowerCase() === "blocked") {
    return { skipped: true, reason: "blocked" };
  }

  const lastCadenceEvent = history.find((event) => {
    const eventType = reminderEventType(event);
    return eventType === "sent" || eventType === "skipped";
  });
  const baseTime = getCadenceBaseTime(lastCadenceEvent) || request.approved_at || request.created_at;
  const scheduledFor = resolveNextReminderAt(
    baseTime,
    request.priority,
    request.reminder_frequency_days,
    request.due_date,
  );

  if (!scheduledFor || new Date(scheduledFor) > now) {
    return { skipped: true, reason: "not_due", scheduledFor };
  }

  const sentAt = now.toISOString();
  await requestService.createReminderEvent(request.id, actorId, sentAt, {
    eventType: "sent",
    scheduledFor,
    metadata: { trigger: "automatic", scheduled_for: scheduledFor },
  });
  await deliverRequestReminder({
    request,
    sentBy: actorId,
    sentAt,
    trigger: "automatic",
    nextReminderAt: resolveNextReminderAt(
      scheduledFor,
      request.priority,
      request.reminder_frequency_days,
      request.due_date,
    ),
  });

  return { sent: true, scheduledFor };
}

async function runReminderAutomation(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const limit = Number.parseInt(options.limit || process.env.REMINDER_AUTOMATION_BATCH_SIZE || "100", 10);
  const candidates = await listAutomationCandidates(Number.isFinite(limit) && limit > 0 ? limit : 100);
  const historyByRequestId = await listHistoryForRequests(candidates.map((request) => request.id));
  const summary = { scanned: candidates.length, sent: 0, overdue: 0, skipped: 0, errors: 0 };

  for (const request of candidates) {
    try {
      const result = await processReminderRequest(request, historyByRequestId[request.id] || [], now);
      if (result.sent) summary.sent += 1;
      else if (result.overdue) summary.overdue += 1;
      else summary.skipped += 1;
    } catch (err) {
      summary.errors += 1;
      console.error(`[Reminder Automation] Request ${request.id} failed:`, err.message);
    }
  }

  return summary;
}

function startReminderAutomation() {
  if (timer || process.env.REMINDER_AUTOMATION_DISABLED === "true") return null;
  const intervalMs = Number.parseInt(process.env.REMINDER_AUTOMATION_INTERVAL_MS || `${DEFAULT_INTERVAL_MS}`, 10);
  const delayMs = Number.parseInt(process.env.REMINDER_AUTOMATION_START_DELAY_MS || "30000", 10);
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const summary = await runReminderAutomation();
      if (summary.sent || summary.overdue || summary.errors) {
        console.log("[Reminder Automation]", summary);
      }
    } catch (err) {
      console.error("[Reminder Automation] Run failed:", err.message);
    } finally {
      running = false;
    }
  };

  timer = setInterval(run, Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_INTERVAL_MS);
  setTimeout(run, Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : 30000);
  return timer;
}

function stopReminderAutomation() {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
}

module.exports = {
  runReminderAutomation,
  startReminderAutomation,
  stopReminderAutomation,
};
