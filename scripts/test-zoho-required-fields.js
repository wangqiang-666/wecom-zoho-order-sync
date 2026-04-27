/**
 * 测试 ZOHO CustomModule18 的实际必填字段
 *
 * 策略：
 *   1. 先用空 payload 试 → 看 ZOHO 返回哪些字段 required
 *   2. 逐步补字段直到能成功创建
 *   3. 创建成功后立即删除测试记录
 *
 * 用法：node scripts/test-zoho-required-fields.js
 */

const config = require("../src/config");
const { zohoFetch } = require("../src/services/zoho-write");
const logger = require("../src/utils/logger");

async function testMinimalPayload() {
  logger.info("🧪 测试 ZOHO %s 最小必填字段集", config.zoho.moduleApiName);

  // 测试用 payload 集合（从空到逐步补全）
  const testCases = [
    {
      name: "空 payload",
      data: {}
    },
    {
      name: "仅 Name（主题）",
      data: {
        Name: "TEST-REQUIRED-FIELDS-" + Date.now()
      }
    },
    {
      name: "Name + Owner",
      data: {
        Name: "TEST-REQUIRED-FIELDS-" + Date.now(),
        Owner: config.zoho.defaultOwnerId
      }
    },
    {
      name: "Name + Owner + 基础必填（根据 field-map 推测）",
      data: {
        Name: "TEST-REQUIRED-FIELDS-" + Date.now(),
        Owner: config.zoho.defaultOwnerId,
        field: "2026-04-23",  // 订单日期
        field6: "测试公司中文名",  // 公证主体中文名
        field20: 100,  // 10订单金额
        field22: config.zoho.defaultCurrency,  // 币种
        field25: 1,  // 9附件数量
        field28: 0,  // 彩打页数
        field36: "测试注意事项",  // 其他注意事项
        field76: "/test/path",  // 文件存放路径
        field179: "测试文件名",  // 需递交文件名
        field213: "10",  // 总页数
        field216: "测试文案",  // 文案
        field223: "测试导入者",  // 订单导入者
        field229: "测试使用地",  // 1公证书使用地
        field31: "否",  // 删除不负责证词
        field52: "普通",  // 供应商（picklist，先试个值）
      }
    }
  ];

  for (const tc of testCases) {
    logger.info("\n--- 测试: %s ---", tc.name);
    try {
      const result = await zohoFetch(`/${config.zoho.moduleApiName}`, {
        method: "POST",
        body: JSON.stringify({ data: [tc.data] })
      });

      if (result.data && result.data[0]?.code === "SUCCESS") {
        const recordId = result.data[0].details.id;
        logger.info("✅ 创建成功! record_id=%s", recordId);
        logger.info("   使用字段: %s", Object.keys(tc.data).join(", "));

        // 立即删除测试记录
        try {
          await zohoFetch(`/${config.zoho.moduleApiName}?ids=${recordId}`, {
            method: "DELETE"
          });
          logger.info("   已删除测试记录");
        } catch (e) {
          logger.warn("   删除失败: %s", e.message);
        }

        return { success: true, fields: Object.keys(tc.data) };
      } else {
        logger.warn("❌ 创建失败: %s", JSON.stringify(result.data?.[0] || result, null, 2));
      }
    } catch (e) {
      logger.error("❌ API 调用失败: %s", e.message);
      if (e.response?.data) {
        logger.error("   响应: %s", JSON.stringify(e.response.data, null, 2));
      }
    }
  }

  return { success: false };
}

async function fetchFieldMetadata() {
  logger.info("\n🔍 尝试拉取 ZOHO 字段元数据...");
  try {
    const result = await zohoFetch(`/settings/fields?module=${config.zoho.moduleApiName}`);
    if (result.fields) {
      const required = result.fields.filter(f => f.required || f.system_mandatory);
      logger.info("✅ ZOHO 端标记为必填的字段 (%d 个):", required.length);
      required.forEach(f => {
        logger.info("   - %s (api_name=%s, type=%s)",
          f.field_label || f.display_label,
          f.api_name,
          f.data_type
        );
      });
      return required;
    }
  } catch (e) {
    logger.warn("⚠ 无法拉取字段元数据: %s", e.message);
  }
  return null;
}

(async () => {
  try {
    // 先尝试拉元数据
    await fetchFieldMetadata();

    // 再测试最小 payload
    const result = await testMinimalPayload();

    if (result.success) {
      logger.info("\n🎯 结论: ZOHO 端最小必填字段集已找到（见上方 ✅）");
    } else {
      logger.info("\n⚠ 所有测试 payload 均失败，需要手动调整 testCases");
    }
  } catch (e) {
    logger.error("测试失败: %s", e.stack);
    process.exit(1);
  }
})();
