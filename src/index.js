/**
 * 服务入口
 *   - 启动时打印配置自检
 *   - notify flush（每10秒）
 *   - 每日汇总（cron 表达式由 .env 决定）
 *   - 企微文档回调：检测"是否确定导入"="导入"，立即触发同步
 *   - 健康检查 + 管理 API（给 Web UI 用）
 */

const cron = require("node-cron");
const config = require("./config");
const logger = require("./utils/logger");
const notifyJob = require("./jobs/notify-job");
const runtimeConfig = require("./utils/runtime-config");
const wecomSheet = require("./services/wecom-sheet");
const adminServer = require("./services/admin-server");
const syncJob = require("./jobs/sync-job");
const db = require("./utils/db");

let pollTimer = null;
let isTickRunning = false;

/**
 * Web UI 改配置后调一下：失效 sheet meta（下一轮重扫子表）
 */
function reschedule() {
  wecomSheet.invalidateMeta();
  return startPoller();
}

function startPoller() {
  const sec = runtimeConfig.getPollIntervalSec();
  if (pollTimer) clearInterval(pollTimer);

  async function tick() {
    if (isTickRunning) {
      logger.debug("[poll] 上一轮还在执行，跳过本次tick");
      return;
    }

    isTickRunning = true;
    try {
      const dirtySince = db.getSheetDirtySince();
      const cooldownMs = runtimeConfig.getRowCooldownSec() * 1000;
      const pendingReady = db.hasPendingReady(cooldownMs);
      // webhook 偶发漏事件时，仍需主动扫描「是否确定导入」=「导入」的行。
      // 这条路径只处理显式导入行，不会打扰未确认的半填行。
      if (!dirtySince && !pendingReady) {
        const result = await syncJob.processPendingImports();
        if (result?.total) logger.info("[poll] 待导入兜底扫描完成: %o", result);
        return;
      }

      const snapshot = Date.now();
      const reason = dirtySince ? "sheet_dirty" : "pending_ready";
      logger.info("[poll] 触发兜底扫描 reason=%s interval=%ds", reason, sec);
      const result = await syncJob.runOnce();
      if (!result?.skipped && !result?.error && dirtySince) db.clearSheetDirty(snapshot);
    } finally {
      isTickRunning = false;
    }
  }

  pollTimer = setInterval(() => tick().catch((e) => logger.error("[poll] tick 异常: %s", e.stack || e)), sec * 1000);
  pollTimer.unref?.();
  logger.info("[poll] 轮询兜底已启动: 每 %d 秒", sec);
  return { ok: true, sec };
}

async function main() {
  config.printSummary(logger);
  logger.info("[runtime] sheets filter = %o", runtimeConfig.getSheetFilter());
  logger.info("[runtime] 实时触发模式：用户输入「导入」后立即执行");
  startPoller();

  setInterval(() => {
    notifyJob.flushFailQueue().catch((e) => logger.error("notify flush 异常: %s", e.message));
  }, 10_000);

  cron.schedule(config.cron.dailyReport, () => {
    notifyJob.sendDailyReport().catch((e) => logger.error("日报发送异常: %s", e.message));
  });
  logger.info("日报 cron 已启动: %s", config.cron.dailyReport);

  // 企微回调服务：检测"是否确定导入"="导入"，立即触发同步
  try {
    const wecomCallback = require("./services/wecom-callback");
    wecomCallback.start();
    logger.info("[callback] webhook 已启动，用户输入「导入」后会立即执行同步");
  } catch (e) {
    logger.warn("[callback] 未启用（%s）", e.message);
  }

  // 管理 + 健康检查服务
  adminServer.start({ reschedule });
}

main().catch((e) => {
  logger.error("启动失败: %s", e.stack || e);
  process.exit(1);
});

module.exports = { reschedule };
