/**
 * 通知任务：消费 notify_queue + 定时日报
 */

const config = require("../config");
const logger = require("../utils/logger");
const db = require("../utils/db");
const runtimeConfig = require("../utils/runtime-config");
const { notifySyncFail, notifyDaily } = require("../services/wecom-app");

async function flushFailQueue() {
  const pending = db.pendingNotifies().filter((p) => p.kind === "fail");
  if (!pending.length) return;

  // 通知开关关闭：消费掉队列但不发，避免积压也不骚扰群
  if (!runtimeConfig.isNotifyEnabled()) {
    for (const item of pending) db.markNotifySent(item.id);
    logger.debug("[notify] 通知已关闭，吞掉 %d 条失败事件（不发微信）", pending.length);
    return;
  }

  for (const item of pending) {
    try {
      await notifySyncFail(item.payload);
      db.markNotifySent(item.id);
    } catch (e) {
      logger.error("失败通知发送失败 id=%d: %s", item.id, e.message);
    }
  }
}

async function sendDailyReport() {
  if (!runtimeConfig.isNotifyEnabled()) {
    logger.debug("[notify] 日报跳过（通知已关闭）");
    return;
  }
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 1); // 昨天 0 点
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const stats = db.statsSince(start.getTime());
  const failed = db.failedSince(start.getTime()).map((r) => ({
    rowIndex: "-",
    orderConfirmNo: r.business_key,
    reason: (r.last_error || "").slice(0, 100),
  }));

  await notifyDaily({
    date: start.toISOString().slice(0, 10),
    total: (stats.ok || 0) + (stats.failed || 0),
    success: stats.ok || 0,
    failed: stats.failed || 0,
    failItems: failed,
  });
}

module.exports = { flushFailQueue, sendDailyReport };
