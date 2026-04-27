/**
 * 单元测试：file-no、db、wecom-sheet hash 与空行过滤
 *
 * 不依赖运行中的服务，直接调用模块。DB 用临时实例。
 */

require("dotenv").config();
const path = require("path");
const fs = require("fs");
const os = require("os");

// 用临时 DB 路径以免污染真实 orders.db
const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "wzs-test-"));
process.env.DB_PATH = path.join(tmpDbDir, "test.db");

const { extractCustomerCode, generateForCustomer, PREFIX } = require("../src/utils/file-no");
const wecomSheet = require("../src/services/wecom-sheet");

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { console.log(`  ✅ ${name}${extra ? "  — " + extra : ""}`); pass++; }
  else      { console.log(`  ❌ ${name}${extra ? "  — " + extra : ""}`); fail++; }
}

(async () => {
  console.log("🧪 file-no / hash / 空行过滤 单元测试\n");

  // ---- extractCustomerCode ----
  console.log("=== extractCustomerCode ===");
  check("A12421 → 12421", extractCustomerCode("A12421") === "12421");
  check("空 → null", extractCustomerCode("") === null);
  check("纯字母 → null", extractCustomerCode("ABC") === null);
  check("12345 → 12345", extractCustomerCode("12345") === "12345");
  check("混合 X100Y200 → 100", extractCustomerCode("X100Y200") === "100");
  check("undefined → null", extractCustomerCode(undefined) === null);

  // ---- generateForCustomer ----
  console.log("\n=== generateForCustomer ===");
  const used = new Set();
  const fakeFetch = async () => ({ data: [{ id: "ACC1", field62: "A99999" }] });
  {
    const r = await generateForCustomer({
      customerName: "X",
      zohoFetch: fakeFetch,
      isFileNoUsed: (n) => used.has(n),
      markUsed: (n) => used.add(n),
    });
    check("正常生成 IN/NP/99999/.../YYYY",
      r.fileNo.startsWith("IN/NP/99999/") && r.fileNo.endsWith(`/${new Date().getFullYear()}`));
    check("customerCode = 99999", r.customerCode === "99999");
    check("accountId = ACC1", r.accountId === "ACC1");
  }
  {
    // ZOHO 返回空 → TMP 兜底
    const r = await generateForCustomer({
      customerName: "Y",
      zohoFetch: async () => ({ data: [] }),
      isFileNoUsed: (n) => used.has(n),
      markUsed: (n) => used.add(n),
    });
    check("ZOHO 查不到 → TMP 段", r.fileNo.startsWith("IN/NP/TMP/"));
    check("accountId 为 null", r.accountId === null);
  }
  {
    // ZOHO 抛异常 → TMP 兜底，不爆
    const r = await generateForCustomer({
      customerName: "Z",
      zohoFetch: async () => { throw new Error("ZOHO 500"); },
      isFileNoUsed: () => false,
      markUsed: () => {},
    });
    check("ZOHO 异常 → TMP 兜底不抛", r.fileNo.startsWith("IN/NP/TMP/"));
  }
  {
    // 缓存命中：第二次同客户不再调 fetch
    const cache = new Map();
    let calls = 0;
    const fetchCount = async () => { calls++; return { data: [{ id: "C1", field62: "A1" }] }; };
    await generateForCustomer({ customerName: "K", zohoFetch: fetchCount, isFileNoUsed: () => false, markUsed: () => {}, customerCodeCache: cache });
    await generateForCustomer({ customerName: "K", zohoFetch: fetchCount, isFileNoUsed: () => false, markUsed: () => {}, customerCodeCache: cache });
    check("customerCodeCache 命中只调 1 次", calls === 1);
  }
  {
    // 并发模拟：1000 次随机段，全部不重复（统计学概率）
    const seen = new Set();
    let dup = 0;
    for (let i = 0; i < 1000; i++) {
      const r = await generateForCustomer({
        customerName: "P",
        zohoFetch: async () => ({ data: [{ id: "X", field62: "A1" }] }),
        isFileNoUsed: (n) => seen.has(n),
        markUsed: (n) => seen.add(n),
      });
      if (r.fileNo === undefined) dup++;
    }
    check("1000 次生成无冲突（查重函数生效）", dup === 0 && seen.size === 1000);
  }
  {
    // 缺参数应抛
    let threw = false;
    try { await generateForCustomer({}); } catch { threw = true; }
    check("缺 customerName 抛错", threw);
  }
  {
    // 客户名带括号 → criteria 转义
    let captured = "";
    await generateForCustomer({
      customerName: "公司(测试)",
      zohoFetch: async (url) => { captured = url; return { data: [{ id: "X", field62: "A1" }] }; },
      isFileNoUsed: () => false,
      markUsed: () => {},
    });
    check("括号被反斜杠转义", /%5C\(/.test(captured) && /%5C\)/.test(captured), `url=${captured.slice(0, 80)}`);
  }

  // ---- wecom-sheet hashRow ----
  console.log("\n=== wecom-sheet hashRow ===");
  {
    const a = wecomSheet.hashRow({ "公证主体中文名": "X", "导入状态": "导入成功" });
    const b = wecomSheet.hashRow({ "公证主体中文名": "X", "导入状态": "导入失败" });
    check("hash 排除「导入状态」列（同业务字段同 hash）", a === b);
  }
  {
    const a = wecomSheet.hashRow({ "公证主体中文名": "X" });
    const b = wecomSheet.hashRow({ "公证主体中文名": "Y" });
    check("业务字段变化 hash 变化", a !== b);
  }
  {
    const a = wecomSheet.hashRow({ "a": "1", "b": "2" });
    const b = wecomSheet.hashRow({ "b": "2", "a": "1" });
    check("hash 与 key 顺序无关", a === b);
  }
  {
    const a = wecomSheet.hashRow({ "x": null });
    const b = wecomSheet.hashRow({ "x": undefined });
    const c = wecomSheet.hashRow({ "x": "" });
    check("null/undefined/空字符串 hash 等价", a === b && b === c);
  }


  console.log("\n=== changed import row filter ===");
  {
    const row = { "主题": "", "渠道名称": "", "是否确定导入": "导入", "导入状态": "" };
    const h = wecomSheet.hashRow(row);
    check("已点击导入的缺字段行 hash 可生成", typeof h === "string" && h.length === 40);
  }

  console.log(`\n🎯 汇总: ${pass} 通过 / ${fail} 失败`);
  // 清理临时 DB
  try { fs.rmSync(tmpDbDir, { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
