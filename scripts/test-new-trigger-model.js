/**
 * 测试新的"是否确定导入"触发模型
 *
 * 前置条件：
 * 1. 所有 CS_* 子表已添加"是否确定导入"列（单选下拉，选项"导入"）
 * 2. 服务未启动（本脚本模拟手动触发）
 *
 * 测试流程：
 * 1. 读取所有行，找到"是否确定导入"="导入"的行
 * 2. 调用 processSingleRow 处理
 * 3. 验证结果并保留数据
 */

require("dotenv").config();
const sheet = require("../src/services/wecom-sheet");
const syncJob = require("../src/jobs/sync-job");
const logger = require("../src/utils/logger");

async function main() {
  logger.info("=== 测试新触发模型 ===");

  // 1. 读取所有行
  logger.info("Step 1: 读取企微表格所有行...");
  let rows;
  try {
    rows = await sheet.readRows();
  } catch (e) {
    logger.error("读取失败: %s", e.message);
    logger.error("请确保所有 CS_* 子表已添加「是否确定导入」列");
    process.exit(1);
  }
  logger.info("共读取 %d 行", rows.length);

  // 2. 找到"是否确定导入"="导入"的行
  const pendingRows = rows.filter((r) => {
    const val = String(r.data["是否确定导入"] || "").trim();
    return val === "导入";
  });

  if (pendingRows.length === 0) {
    logger.warn("⚠️  没有找到「是否确定导入」=「导入」的行");
    logger.info("提示：请在企微表格中选择一行，将「是否确定导入」列设为「导入」");
    process.exit(0);
  }

  logger.info("发现 %d 行待导入:", pendingRows.length);
  for (const r of pendingRows) {
    logger.info("  - 行%d: 订单确认编号=%s, 渠道名称=%s",
      r.rowIndex,
      r.data["订单确认编号"] || "(空)",
      r.data["渠道名称"] || "(空)"
    );
  }

  // 3. 逐行处理
  logger.info("\nStep 2: 开始处理...");
  let ok = 0, failed = 0, skipped = 0;

  for (const row of pendingRows) {
    logger.info("\n处理行%d (rowId=%s)...", row.rowIndex, row.rowId);
    try {
      const result = await syncJob.processSingleRow(row.rowId);
      if (result?.ok) {
        ok++;
        logger.info("  ✅ 成功");
      } else if (result?.failed) {
        failed++;
        logger.warn("  ❌ 失败");
      } else if (result?.skipped) {
        skipped++;
        logger.info("  ⏭ 跳过: %s", result.reason || "unknown");
      } else if (result?.error) {
        failed++;
        logger.error("  ❌ 错误: %s", result.error);
      }
    } catch (e) {
      failed++;
      logger.error("  ❌ 异常: %s", e.message);
    }
  }

  // 4. 汇总
  logger.info("\n=== 测试完成 ===");
  logger.info("成功: %d, 失败: %d, 跳过: %d", ok, failed, skipped);

  // 5. 验证回写
  logger.info("\nStep 3: 验证回写结果...");
  const rowsAfter = await sheet.readRows();
  for (const row of pendingRows) {
    const after = rowsAfter.find((r) => r.rowId === row.rowId);
    if (!after) {
      logger.warn("  ⚠️  行%d 未找到（可能被删除）", row.rowIndex);
      continue;
    }
    logger.info("  行%d: 是否确定导入=%s, 导入状态=%s",
      after.rowIndex,
      after.data["是否确定导入"] || "(空)",
      after.data["导入状态"] || "(空)"
    );
  }

  logger.info("\n✅ 测试完成，数据已保留在企微和ZOHO");
}

main().catch((e) => {
  logger.error("测试失败: %s", e.stack || e);
  process.exit(1);
});
