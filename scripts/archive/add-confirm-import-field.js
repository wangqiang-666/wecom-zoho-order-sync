/**
 * 给所有 CS_* 子表添加"是否确定导入"字段（单选下拉，选项只有"导入"）
 */

require("dotenv").config();
const sheet = require("../src/services/wecom-sheet");
const logger = require("../src/utils/logger");
const runtimeConfig = require("../src/utils/runtime-config");

async function main() {
  // 先读取所有子表元数据（不校验字段，直接读 docid 下的所有 sheets）
  const docid = process.env.WECOM_SHEET_DOCID;
  if (!docid) throw new Error("WECOM_SHEET_DOCID 未配置");

  logger.info("拉取 docid=%s 所有子表...", docid);
  const doc = await sheet.api("get_sheet_list", { docid, offset: 0, limit: 100 });
  const allSheets = doc.sheet_list || [];
  logger.info("共 %d 个子表", allSheets.length);

  // 过滤出目标子表（CS_* 或白名单）
  const filter = runtimeConfig.getSheetFilter();
  const targetSheets = allSheets.filter((s) => {
    if (filter.whitelist && filter.whitelist.length) {
      return filter.whitelist.includes(s.title);
    }
    if (filter.excludes.includes(s.title)) return false;
    return s.title.startsWith(filter.prefix);
  });

  logger.info("目标子表（%d 个）: %s", targetSheets.length, targetSheets.map((s) => s.title).join(", "));

  for (const s of targetSheets) {
    logger.info("处理子表「%s」(sheet_id=%s)...", s.title, s.sheet_id);

    // 读取现有字段
    const fields = await sheet.api("get_fields", {
      docid, sheet_id: s.sheet_id, offset: 0, limit: 1000,
    });
    const fieldByTitle = Object.fromEntries(fields.fields.map((f) => [f.field_title, f]));

    // 检查是否已有"是否确定导入"字段
    if (fieldByTitle["是否确定导入"]) {
      logger.info("  ✓ 已存在「是否确定导入」字段，跳过");
      continue;
    }

    // 添加字段（单选下拉，选项只有"导入"）
    logger.info("  + 添加「是否确定导入」字段...");
    const result = await sheet.api("add_fields", {
      docid,
      sheet_id: s.sheet_id,
      fields: [
        {
          field_title: "是否确定导入",
          field_type: 1,  // 1=单行文本（企微智能表格的单选下拉需要先创建文本字段，再通过 UI 转换）
          property: {},
        },
      ],
    });
    logger.info("  ✓ 添加成功: field_id=%s", result.fields?.[0]?.field_id || "unknown");
  }

  logger.info("✅ 所有子表处理完成");
  logger.warn("⚠️  注意：企微 API 只能创建文本字段，需要手动在 UI 中将「是否确定导入」转换为单选下拉，选项设为「导入」");
}

main().catch((e) => {
  logger.error("执行失败: %s", e.stack || e);
  process.exit(1);
});
