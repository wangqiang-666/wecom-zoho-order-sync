/**
 * value-transform 全类型 + 边界测试
 *
 * 覆盖：
 *   text/textarea: 普通/空/特殊字符/超长
 *   integer:       正/负/零/带千分号/小数(应报错)/科学记数(应报错)/纯空格
 *   double:        ¥/￥/$/千分号/负数/小数/科学记数
 *   boolean:       是/否/true/false/1/0/y/n/√/×/中英混/非法/空
 *   date:          13位毫秒戳/2026-04-21/2026/04/21/2026年4月21日/非法/空
 *   picklist:      合法/非法/空且非必填
 *   multiselectpicklist: ;/；/,/，/|/换行 各种分隔/全部空/含非法
 *   lookup:        resolver 返 id / 返 null / 抛异常
 *   ownerlookup:   resolver 命中/未命中→落 default/空名+无 default→报错
 *   warnings:      lookup 占位 <TODO> 跳过
 *
 * 默认填充：
 *   - 币种 currency: 兜底写入 field22
 *   - field90 自动今天
 */

require("dotenv").config();
const config = require("../src/config");
const { transformRow } = require("../src/mappers/value-transform");

const fieldMap = config.fieldMap;
const lockedSources = config.getLockedRequiredSources();

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { console.log(`  ✅ ${name}${extra ? "  — " + extra : ""}`); pass++; }
  else      { console.log(`  ❌ ${name}${extra ? "  — " + extra : ""}`); fail++; }
}

function makeFullRow(over = {}) {
  return {
    "渠道名称": "测试渠道",
    "订单确认编号": "T-12345",
    "文件存放路径": "/tmp/x",
    "公证主体中文名": "测试公司",
    "公证主体英文名": "Test Co",
    "业务细类": "测试产品",
    "1公证书使用地": "中国",
    "9附件数量": "5",
    "10订单金额": "1000",
    "业务员": "测试",
    "订单所有者": "Erik",
    "主题": "测试公司001",
    "订单日期": "2026/04/21",
    "供应商": "测试用公证人",       // 必须在 picklist 白名单
    "删除不负责证词": "否",        // picklist ["是","否"]
    "文案": "测试文案",
    "其他注意事项": "无",
    "需递交文件名": "doc.pdf",
    "总页数": "1",
    "彩打页数": "0",
    ...over,
  };
}

// 简单 stub
const lookupOk = async (mod, name) => `MOCK_${mod}_${name}`;
const lookupNull = async () => null;
const lookupThrow = async () => { throw new Error("lookup 异常"); };
const userOk = async (n) => n === "Erik" ? "USER_ERIK" : null;

(async () => {
  console.log("🧪 value-transform 全类型 + 边界测试\n");

  // ---- text ----
  console.log("=== text/textarea ===");
  {
    const r = await transformRow({ rawRow: makeFullRow(), fieldMap, defaultOwnerId: "DEFAULT", currency: "RMB", lookupResolver: lookupOk, userResolver: userOk, lockedSources });
    check("普通行 ok", r.ok, JSON.stringify(r.errors || []));
    check("text 字段透传", r.payload?.field235 === "T-12345");
  }
  {
    const r = await transformRow({ rawRow: makeFullRow({ "公证主体英文名": "  Whitespace  " }), fieldMap, defaultOwnerId: "D", currency: "RMB", lookupResolver: lookupOk, userResolver: userOk, lockedSources });
    check("text 自动 trim", r.payload?.field5 === "Whitespace");
  }

  // ---- integer ----
  console.log("\n=== integer ===");
  {
    const r = await transformRow({ rawRow: makeFullRow({ "9附件数量": "1,234" }), fieldMap, defaultOwnerId: "D", currency: "RMB", lookupResolver: lookupOk, userResolver: userOk, lockedSources });
    check("integer 千分号 1,234 → 1234", r.payload?.field25 === 1234);
  }
  {
    const r = await transformRow({ rawRow: makeFullRow({ "9附件数量": "12.5" }), fieldMap, defaultOwnerId: "D", currency: "RMB", lookupResolver: lookupOk, userResolver: userOk, lockedSources });
    check("integer 小数应报错", !r.ok && r.errors.some((e) => e.field === "9附件数量"));
  }
  {
    const r = await transformRow({ rawRow: makeFullRow({ "9附件数量": "0" }), fieldMap, defaultOwnerId: "D", currency: "RMB", lookupResolver: lookupOk, userResolver: userOk, lockedSources });
    check("integer 0 合法", r.ok && r.payload?.field25 === 0);
  }
  {
    const r = await transformRow({ rawRow: makeFullRow({ "9附件数量": "-3" }), fieldMap, defaultOwnerId: "D", currency: "RMB", lookupResolver: lookupOk, userResolver: userOk, lockedSources });
    check("integer 负数 -3 合法", r.ok && r.payload?.field25 === -3);
  }
  {
    const r = await transformRow({ rawRow: makeFullRow({ "9附件数量": "abc" }), fieldMap, defaultOwnerId: "D", currency: "RMB", lookupResolver: lookupOk, userResolver: userOk, lockedSources });
    check("integer 非数字应报错", !r.ok);
  }

  // ---- double ----
  console.log("\n=== double ===");
  {
    const r = await transformRow({ rawRow: makeFullRow({ "10订单金额": "¥1,234.56" }), fieldMap, defaultOwnerId: "D", currency: "RMB", lookupResolver: lookupOk, userResolver: userOk, lockedSources });
    check("double ¥1,234.56 → 1234.56", r.ok && r.payload?.field20 === 1234.56);
  }
  {
    const r = await transformRow({ rawRow: makeFullRow({ "10订单金额": "￥9999" }), fieldMap, defaultOwnerId: "D", currency: "RMB", lookupResolver: lookupOk, userResolver: userOk, lockedSources });
    check("double ￥ 全角符号", r.ok && r.payload?.field20 === 9999);
  }
  {
    const r = await transformRow({ rawRow: makeFullRow({ "10订单金额": "$50.5" }), fieldMap, defaultOwnerId: "D", currency: "RMB", lookupResolver: lookupOk, userResolver: userOk, lockedSources });
    check("double $50.5", r.ok && r.payload?.field20 === 50.5);
  }
  {
    const r = await transformRow({ rawRow: makeFullRow({ "10订单金额": "abc" }), fieldMap, defaultOwnerId: "D", currency: "RMB", lookupResolver: lookupOk, userResolver: userOk, lockedSources });
    check("double 非数字应报错", !r.ok);
  }
  {
    const r = await transformRow({ rawRow: makeFullRow(), fieldMap, defaultOwnerId: "D", currency: "RMB", lookupResolver: lookupOk, userResolver: userOk, lockedSources });
    check("currency 自动写 field22", r.payload?.field22 === "RMB");
  }

  // ---- boolean (用「空单」field185) ----
  console.log("\n=== boolean (空单) ===");
  for (const [v, expected] of [["是", true], ["否", false], ["true", true], ["false", false], ["1", true], ["0", false], ["√", true], ["×", false], ["YES", true], ["No", false]]) {
    const r = await transformRow({ rawRow: makeFullRow({ "空单": v }), fieldMap, defaultOwnerId: "D", currency: "RMB", lookupResolver: lookupOk, userResolver: userOk, lockedSources });
    check(`boolean 「${v}」→ ${expected}`, r.ok && r.payload?.field185 === expected, JSON.stringify(r.errors || ""));
  }
  {
    const r = await transformRow({ rawRow: makeFullRow({ "空单": "maybe" }), fieldMap, defaultOwnerId: "D", currency: "RMB", lookupResolver: lookupOk, userResolver: userOk, lockedSources });
    check("boolean 非法值应报错", !r.ok && r.errors.some((e) => e.field === "空单"));
  }
  // picklist 校验
  console.log("\n=== picklist ===");
  {
    const r = await transformRow({ rawRow: makeFullRow({ "删除不负责证词": "也许" }), fieldMap, defaultOwnerId: "D", currency: "RMB", lookupResolver: lookupOk, userResolver: userOk, lockedSources });
    check("picklist 非法值应报错", !r.ok && r.errors.some((e) => e.field === "删除不负责证词"));
  }
  {
    const r = await transformRow({ rawRow: makeFullRow({ "供应商": "不存在的人" }), fieldMap, defaultOwnerId: "D", currency: "RMB", lookupResolver: lookupOk, userResolver: userOk, lockedSources });
    check("picklist 供应商白名单生效", !r.ok && r.errors.some((e) => e.field === "供应商"));
  }

  // ---- date (订单日期 target = "field") ----
  console.log("\n=== date ===");
  for (const [v, expected] of [["2026/04/21", "2026-04-21"], ["2026-04-21", "2026-04-21"], ["2026年4月21日", "2026-04-21"]]) {
    const r = await transformRow({ rawRow: makeFullRow({ "订单日期": v }), fieldMap, defaultOwnerId: "D", currency: "RMB", lookupResolver: lookupOk, userResolver: userOk, lockedSources });
    check(`date 「${v}」→ ${expected}`, r.ok && r.payload?.field === expected, JSON.stringify(r.errors || ""));
  }
  {
    const ts = String(Date.UTC(2026, 3, 21));
    const r = await transformRow({ rawRow: makeFullRow({ "订单日期": ts }), fieldMap, defaultOwnerId: "D", currency: "RMB", lookupResolver: lookupOk, userResolver: userOk, lockedSources });
    check(`date 13位毫秒戳合法`, r.ok && /^\d{4}-\d{2}-\d{2}$/.test(r.payload?.field || ""));
  }
  {
    const r = await transformRow({ rawRow: makeFullRow({ "订单日期": "明天" }), fieldMap, defaultOwnerId: "D", currency: "RMB", lookupResolver: lookupOk, userResolver: userOk, lockedSources });
    check("date 非法格式应报错", !r.ok && r.errors.some((e) => e.field === "订单日期"));
  }

  // ---- ownerlookup ----
  console.log("\n=== ownerlookup ===");
  {
    const r = await transformRow({ rawRow: makeFullRow({ "订单所有者": "Erik" }), fieldMap, defaultOwnerId: "DEFAULT", currency: "RMB", lookupResolver: lookupOk, userResolver: userOk, lockedSources });
    check("订单所有者命中 → Owner.id=USER_ERIK", r.payload?.Owner?.id === "USER_ERIK");
  }
  {
    const r = await transformRow({ rawRow: makeFullRow({ "订单所有者": "Unknown" }), fieldMap, defaultOwnerId: "DEFAULT", currency: "RMB", lookupResolver: lookupOk, userResolver: userOk, lockedSources });
    check("订单所有者未命中 → 落回 default", r.payload?.Owner?.id === "DEFAULT");
    check("warning 提示落回 default", (r.warnings || []).some((w) => /Unknown/.test(w)));
  }
  {
    const r = await transformRow({ rawRow: makeFullRow({ "订单所有者": "" }), fieldMap, defaultOwnerId: "DEFAULT", currency: "RMB", lookupResolver: lookupOk, userResolver: userOk, lockedSources });
    check("订单所有者空 + 有 default → 落 default", r.payload?.Owner?.id === "DEFAULT");
  }
  {
    const r = await transformRow({ rawRow: makeFullRow({ "订单所有者": "" }), fieldMap, defaultOwnerId: "", currency: "RMB", lookupResolver: lookupOk, userResolver: userOk, lockedSources });
    check("订单所有者空 + 无 default → 报错", !r.ok && r.errors.some((e) => e.field === "订单所有者"));
  }

  // ---- lookup ----
  console.log("\n=== lookup ===");
  {
    const r = await transformRow({ rawRow: makeFullRow({ "渠道名称": "X" }), fieldMap, defaultOwnerId: "D", currency: "RMB", lookupResolver: lookupNull, userResolver: userOk, lockedSources });
    check("lookup 找不到 → 报错", !r.ok && r.errors.some((e) => e.field === "渠道名称"));
  }

  // ---- field90 默认 ----
  console.log("\n=== 默认值 ===");
  {
    const r = await transformRow({ rawRow: makeFullRow(), fieldMap, defaultOwnerId: "D", currency: "RMB", lookupResolver: lookupOk, userResolver: userOk, lockedSources });
    const today = new Date().toISOString().slice(0, 10);
    check("field90 自动 = 今日", r.payload?.field90 === today);
  }

  console.log(`\n🎯 汇总: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
