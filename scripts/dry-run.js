/**
 * dry-run：用本地 xlsx 当数据源跑完整同步流程，但不实际写 ZOHO、不回写企微表格
 *
 * 用法：SAMPLE_XLSX=/Users/yyzinotary/Desktop/主表.xlsx node scripts/dry-run.js
 */

const config = require("../src/config");
const logger = require("../src/utils/logger");
const syncJob = require("../src/jobs/sync-job");

async function main() {
  if (!process.env.SAMPLE_XLSX) {
    logger.error("请设置 SAMPLE_XLSX=/path/to/主表.xlsx");
    process.exit(2);
  }
  config.printSummary(logger);
  logger.warn("=== DRY-RUN 模式：不会真正写 ZOHO，不会回写企微 ===");
  const stats = await syncJob.runOnce({ dryRun: true });
  logger.info("汇总: %o", stats);
}

main().catch((e) => {
  logger.error("失败: %s", e.stack || e);
  process.exit(1);
});
