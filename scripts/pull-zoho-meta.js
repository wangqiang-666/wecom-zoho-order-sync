/**
 * 一次性：拉取 ZOHO CustomModule18 的全部字段元数据
 *   - 和本地 field-map.json 做交叉校验（picklist 值漂移？字段删除？新增？）
 *   - 输出到 docs/zoho-fields-dump.json 供人工检视
 *
 * 用法：node scripts/pull-zoho-meta.js
 */

const fs = require("fs");
const path = require("path");
const config = require("../src/config");
const logger = require("../src/utils/logger");
const { zohoFetch } = require("../src/services/zoho-write");

async function main() {
  logger.info("拉取 %s 字段元数据...", config.zoho.moduleApiName);
  const data = await zohoFetch(`/settings/fields?module=${config.zoho.moduleApiName}`);
  const fields = data.fields || [];
  logger.info("共 %d 个字段", fields.length);

  const dumpPath = path.join(__dirname, "..", "docs", "zoho-fields-dump.json");
  fs.writeFileSync(dumpPath, JSON.stringify(fields, null, 2));
  logger.info("字段元数据已保存: %s", dumpPath);

  // 交叉校验本地映射
  const byApi = new Map(fields.map((f) => [f.api_name, f]));
  const mismatches = [];
  for (const spec of config.fieldMap.fields) {
    if (spec.type === "local") continue;
    const zoho = byApi.get(spec.target);
    if (!zoho) {
      mismatches.push(`❌ ${spec.source} → ${spec.target} 在 ZOHO 中不存在`);
      continue;
    }
    // picklist 值漂移检测
    if ((spec.type === "picklist" || spec.type === "multiselectpicklist") && spec.picklist) {
      const zohoVals = (zoho.pick_list_values || []).map((v) => v.display_value);
      const missing = spec.picklist.filter((v) => !zohoVals.includes(v));
      const extra = zohoVals.filter((v) => v !== "-None-" && !spec.picklist.includes(v));
      if (missing.length) mismatches.push(`⚠ ${spec.source}: 本地有但 ZOHO 无: ${missing.join(",")}`);
      if (extra.length) mismatches.push(`ℹ ${spec.source}: ZOHO 新增可选值: ${extra.join(",")}`);
    }
  }

  if (mismatches.length) {
    logger.warn("交叉校验发现 %d 处差异:", mismatches.length);
    for (const m of mismatches) logger.warn("  %s", m);
  } else {
    logger.info("✅ 本地 field-map.json 与 ZOHO 元数据一致");
  }
}

main().catch((e) => {
  logger.error("失败: %s", e.stack || e);
  process.exit(1);
});
