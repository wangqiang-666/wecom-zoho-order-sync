/**
 * 必填字段运行时配置测试（聚焦校验逻辑 + 配置存储，不涉及真实 ZOHO 写入）
 *
 * 为什么不做端到端：
 *   - 「主题」是企微表格的公式列（公证主体中文名 & 第几单），插入新行后会被自动填充，
 *     无法构造"空主题"行去验证锁定逻辑。
 *   - 端到端还要满足 picklist/lookup/date 等众多约束，与本特性正交。
 *   - 缓存命中的 "跳过未修改" 路径让"改 override 后立刻重跑"也无意义。
 *
 * 改为直接验证：
 *   - Phase A：配置读写：set/get/reset/JSON 解析容错/locked 强制 union/未知字段过滤
 *   - Phase B：transformRow 必填判定：override=null 走默认；override=[] 时只校验 locked；
 *              override 自定义时按集合校验；locked 字段始终强制
 *
 * 用法：node scripts/test-required-fields-runtime.js
 */

const config = require("../src/config");
const logger = require("../src/utils/logger");
const runtimeConfig = require("../src/utils/runtime-config");
const db = require("../src/utils/db");
const { transformRow } = require("../src/mappers/value-transform");

const RESULTS = [];
function assert(name, cond, detail) {
  RESULTS.push({ name, pass: !!cond, detail });
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? "  — " + detail : ""}`);
}

async function main() {
  logger.info("🧪 必填字段运行时配置测试");
  const lockedSources = config.getLockedRequiredSources();
  const allSpecs = config.getAllFieldSpecs();
  const defaultRequired = allSpecs.filter((s) => s.defaultRequired).map((s) => s.source);

  console.log(`\n锁定字段集: [${[...lockedSources].join(", ")}]`);
  console.log(`field-map 默认必填: ${defaultRequired.length} 个`);

  // 备份原始 DB 配置，结束时恢复
  const ORIGINAL = db.db.prepare("SELECT value FROM app_config WHERE key='required_fields_override'").get();

  try {
    // ============= Phase A: runtime-config 读写 =============
    console.log("\n=== Phase A: runtime-config 读写 ===");

    // A1: reset → null
    runtimeConfig.resetRequiredFieldsOverride();
    assert("A1 reset 后 getRequiredFieldsOverride() === null",
      runtimeConfig.getRequiredFieldsOverride() === null);

    // A2: set 任意数组 → 落库 + locked union + 排序
    const cleaned = runtimeConfig.setRequiredFieldsOverride(["文案", "渠道名称"]);
    const got = runtimeConfig.getRequiredFieldsOverride();
    assert("A2 set 后 get 返回数组", Array.isArray(got));
    assert("A2 包含 locked 字段「主题」",
      cleaned.includes("主题") && got.includes("主题"));
    assert("A2 包含传入字段「文案」「渠道名称」",
      got.includes("文案") && got.includes("渠道名称"));
    assert("A2 已排序", JSON.stringify(got) === JSON.stringify([...got].sort()));

    // A3: 未知字段过滤
    const cleaned3 = runtimeConfig.setRequiredFieldsOverride(["不存在的字段X", "文案"]);
    assert("A3 未知字段被过滤", !cleaned3.includes("不存在的字段X") && cleaned3.includes("文案"));

    // A4: 空数组 → 仍含 locked
    const cleaned4 = runtimeConfig.setRequiredFieldsOverride([]);
    assert("A4 空输入仍 union locked",
      cleaned4.length === lockedSources.size &&
      [...lockedSources].every((s) => cleaned4.includes(s)));

    // A5: 非数组输入 → 视为空 + locked
    const cleaned5 = runtimeConfig.setRequiredFieldsOverride(null);
    assert("A5 null 输入安全降级", Array.isArray(cleaned5) && cleaned5.length === lockedSources.size);

    // A6: JSON 损坏 → 解析失败回落 null + 不抛
    db.setConfig("required_fields_override", "{not json");
    const got6 = runtimeConfig.getRequiredFieldsOverride();
    assert("A6 JSON 损坏 → 安全回落 null", got6 === null);

    // A7: 非数组 JSON → 回落 null
    db.setConfig("required_fields_override", '{"a":1}');
    const got7 = runtimeConfig.getRequiredFieldsOverride();
    assert("A7 非数组 JSON → 回落 null", got7 === null);

    // A8: 字面量 "null" 字符串 → 视为 null
    db.setConfig("required_fields_override", "null");
    const got8 = runtimeConfig.getRequiredFieldsOverride();
    assert("A8 字面量 null → null", got8 === null);

    // ============= Phase B: transformRow 必填判定 =============
    console.log("\n=== Phase B: transformRow 必填判定 ===");

    // 公共参数
    const baseArgs = {
      fieldMap: config.fieldMap,
      defaultOwnerId: "TEST_OWNER",
      currency: "HKD",
      lookupResolver: async () => null,   // 故意不返回，避免触发 lookup 通过
      userResolver: async () => "TEST_OWNER",
      lockedSources,
    };

    // 构造一行：填齐所有 default required（这样 default 模式下应该通过）
    const fullRow = {};
    for (const s of allSpecs) {
      if (s.defaultRequired || s.source === "主题") {
        // 给个无害字符串，picklist/lookup/date 仍可能失败，但必填校验先过
        fullRow[s.source] = "x";
      }
    }
    // 给 lookup/picklist 等高校验字段塞合理值，避免被它们抢先报错
    fullRow["订单确认编号"] = "TEST-NO-1";
    fullRow["公证主体中文名"] = "测试公司";
    fullRow["主题"] = "测试主题";
    fullRow["文案"] = "测试文案";

    // B1: override=null + 缺「渠道名称」 → 报「渠道名称」必填
    {
      const row = { ...fullRow };
      delete row["渠道名称"];
      const r = await transformRow({ ...baseArgs, rawRow: row, requiredOverride: null });
      const hit = !r.ok && r.errors.some((e) => e.field === "渠道名称" && e.reason === "必填为空");
      assert("B1 override=null 时缺「渠道名称」报必填", hit,
        r.ok ? "意外通过" : `errors: ${r.errors.map(e=>e.field).join(",")}`);
    }

    // B2: override=defaultRequired-渠道名称 + 缺「渠道名称」 → 不再报必填
    {
      const row = { ...fullRow };
      delete row["渠道名称"];
      const override = defaultRequired.filter((s) => s !== "渠道名称");
      const r = await transformRow({ ...baseArgs, rawRow: row, requiredOverride: override });
      const stillRequired = !r.ok && r.errors.some((e) => e.field === "渠道名称" && e.reason === "必填为空");
      assert("B2 override 移除「渠道名称」后不再报必填", !stillRequired,
        stillRequired ? "仍被当必填" : "OK");
    }

    // B3: override=[] + 缺「主题」 → locked 强制 → 报「主题」必填
    {
      const row = { ...fullRow };
      delete row["主题"];
      const r = await transformRow({ ...baseArgs, rawRow: row, requiredOverride: [] });
      const hit = !r.ok && r.errors.some((e) => e.field === "主题" && e.reason === "必填为空");
      assert("B3 override=[] 但锁定字段「主题」仍强制必填", hit,
        r.ok ? "意外通过" : `errors: ${r.errors.map(e=>e.field).join(",")}`);
    }

    // B4: override=[] + 缺「渠道名称」（非 locked） → 不报必填
    {
      const row = { ...fullRow };
      delete row["渠道名称"];
      const r = await transformRow({ ...baseArgs, rawRow: row, requiredOverride: [] });
      const stillRequired = !r.ok && r.errors.some((e) => e.field === "渠道名称" && e.reason === "必填为空");
      assert("B4 override=[] 时非锁定字段不强制必填", !stillRequired);
    }

    // B5: override 自定义 + 包含原本 NOT defaultRequired 的字段 → 该字段变必填
    {
      // 找一个 defaultRequired=false 的源字段
      const optional = allSpecs.find((s) =>
        !s.defaultRequired && !s.locked &&
        s.type !== "ownerlookup" && s.type !== "local" &&
        s.source !== "导入状态"
      );
      if (!optional) {
        assert("B5 找到可选字段做反向测试", false, "field-map 无可选字段，跳过");
      } else {
        const row = { ...fullRow };
        delete row[optional.source];
        const r = await transformRow({
          ...baseArgs, rawRow: row,
          requiredOverride: [...defaultRequired, optional.source],
        });
        const hit = !r.ok && r.errors.some((e) => e.field === optional.source && e.reason === "必填为空");
        assert(`B5 override 把可选字段「${optional.source}」变必填`, hit,
          r.ok ? "意外通过" : `errors: ${r.errors.map(e=>e.field).join(",")}`);
      }
    }

    // B6: override=null + 全部默认必填都填齐 → 校验层不报必填错（其他类型错暂忽略）
    {
      const r = await transformRow({ ...baseArgs, rawRow: fullRow, requiredOverride: null });
      const requiredErrors = r.ok ? [] : r.errors.filter((e) => e.reason === "必填为空");
      assert("B6 默认配置下全填齐则无「必填为空」错", requiredErrors.length === 0,
        requiredErrors.length ? `仍报: ${requiredErrors.map(e=>e.field).join(",")}` : "OK");
    }

    // ============= 汇总 =============
    const passed = RESULTS.filter((r) => r.pass).length;
    const failed = RESULTS.length - passed;
    console.log(`\n🎯 测试汇总: ${passed} 通过 / ${failed} 失败 / 共 ${RESULTS.length}`);
    if (failed > 0) {
      console.log("\n失败用例:");
      RESULTS.filter((r) => !r.pass).forEach((r) => console.log(`  ❌ ${r.name}  ${r.detail || ""}`));
    }
    return failed === 0 ? 0 : 1;
  } finally {
    // 恢复原始配置
    if (ORIGINAL?.value !== undefined) {
      db.setConfig("required_fields_override", ORIGINAL.value);
    } else {
      db.db.prepare("DELETE FROM app_config WHERE key='required_fields_override'").run();
    }
    logger.info("已恢复原始 required_fields_override 配置");
  }
}

main().then((code) => process.exit(code)).catch((e) => {
  logger.error("测试异常: %s", e.stack);
  process.exit(1);
});
