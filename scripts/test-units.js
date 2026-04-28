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

const db = require("../src/utils/db");
const {
  extractCustomerCode,
  generateForCustomer,
  PREFIX,
  BAND_SIZE,
  MAX_SEQ,
  formatBandSeq,
  parseBandSeq,
  parseNewRuleFileNo,
  recoverYearMaxSeqFromZoho,
} = require("../src/utils/file-no");
const wecomSheet = require("../src/services/wecom-sheet");
const config = require("../src/config");

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { console.log(`  ✅ ${name}${extra ? "  — " + extra : ""}`); pass++; }
  else      { console.log(`  ❌ ${name}${extra ? "  — " + extra : ""}`); fail++; }
}

function makeFetch({ accountCode = "A99999", recoveryRows = [] } = {}) {
  return async (url) => {
    if (url.startsWith("/Accounts/search")) {
      return accountCode ? { data: [{ id: "ACC1", field62: accountCode }] } : { data: [] };
    }
    if (url.startsWith(`/${config.zoho.moduleApiName}`)) {
      const pageMatch = url.match(/page=(\d+)/);
      const perMatch = url.match(/per_page=(\d+)/);
      const page = pageMatch ? parseInt(pageMatch[1], 10) : 1;
      const perPage = perMatch ? parseInt(perMatch[1], 10) : 100;
      const start = (page - 1) * perPage;
      const end = start + perPage;
      return { data: recoveryRows.slice(start, end) };
    }
    return { data: [] };
  };
}

function resetCounters() {
  db.db.exec("DELETE FROM file_no_counter");
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

  // ---- band format / parse ----
  console.log("\n=== band format / parse ===");
  check("format 1 → A0001", formatBandSeq(1) === "A0001");
  check(`format ${BAND_SIZE} → A9999`, formatBandSeq(BAND_SIZE) === "A9999");
  check(`format ${BAND_SIZE + 1} → B0001`, formatBandSeq(BAND_SIZE + 1) === "B0001");
  check(`format ${MAX_SEQ} → Z9999`, formatBandSeq(MAX_SEQ) === "Z9999");
  check("parse A0001 → seq=1", parseBandSeq("A0001")?.seq === 1);
  check("parse B0001 → seq=10000", parseBandSeq("B0001")?.seq === 10000);
  check("parse 63985 → null", parseBandSeq("63985") === null);
  check("parseNewRuleFileNo 识别新格式", parseNewRuleFileNo(`IN/NP/12421/A0001/${new Date().getFullYear()}`, new Date().getFullYear())?.seq === 1);
  check("parseNewRuleFileNo 忽略旧随机", parseNewRuleFileNo(`IN/NP/12421/EWR30/${new Date().getFullYear()}`, new Date().getFullYear()) === null);

  // ---- db counter ----
  console.log("\n=== db file_no_counter ===");
  db.seedFileNoCounter(2026, 12, "init");
  check("seed 后可读取 counter", db.getFileNoCounter(2026)?.last_seq === 12);
  const reserved1 = db.reserveNextFileNoSeq(2026);
  const reserved2 = db.reserveNextFileNoSeq(2026);
  check("reserve 顺序递增 13", reserved1?.seq === 13);
  check("reserve 顺序递增 14", reserved2?.seq === 14);
  check("seed 不会回退计数器", db.seedFileNoCounter(2026, 5, "local")?.last_seq === 14);

  // ---- recoverYearMaxSeqFromZoho ----
  console.log("\n=== recoverYearMaxSeqFromZoho ===");
  const year = new Date().getFullYear();
  {
    const rows = [
      { field73: `IN/NP/12421/A0387/${year}` },
      { field73: `IN/NP/12421/B0001/${year}` },
      { field73: `IN/NP/12421/63985/${year}` },
      { field73: `IN/NP/12421/EWR30/${year}` },
    ];
    const max = await recoverYearMaxSeqFromZoho({ zohoFetch: makeFetch({ recoveryRows: rows }), year });
    check("恢复取最大新规则序号", max === 10000, `max=${max}`);
  }
  {
    const rows = [
      { field73: `IN/NP/10073/K3605/${year}` },
      { field73: `IN/NP/12421/63985/${year}` },
    ];
    const max = await recoverYearMaxSeqFromZoho({ zohoFetch: makeFetch({ recoveryRows: rows }), year });
    check("历史伪命中新规则时会被识别（上线前需清理）", max === 103595, `max=${max}`);
  }
  {
    const rows = [
      { field73: `IN/NP/12421/63985/${year}` },
      { field73: `IN/NP/12421/EWR30/${year}` },
    ];
    const max = await recoverYearMaxSeqFromZoho({ zohoFetch: makeFetch({ recoveryRows: rows }), year });
    check("全是旧格式时恢复为 0", max === 0, `max=${max}`);
  }

  // ---- generateForCustomer ----
  console.log("\n=== generateForCustomer ===");
  resetCounters();
  const testYear = 2099;
  const used = new Set();
  const baseFetch = makeFetch({ accountCode: "A99999", recoveryRows: [] });
  {
    const r = await generateForCustomer({
      customerName: "X",
      zohoFetch: baseFetch,
      isFileNoUsed: (n) => used.has(n),
      markUsed: (n) => used.add(n),
      now: new Date(`${testYear}-01-02T10:00:00+08:00`),
    });
    check("首次生成从 A0001 开始", r.fileNo === `IN/NP/99999/A0001/${testYear}`, r.fileNo);
    check("customerCode = 99999", r.customerCode === "99999");
    check("seq = 1", r.seq === 1);
  }
  {
    const r = await generateForCustomer({
      customerName: "X",
      zohoFetch: baseFetch,
      isFileNoUsed: (n) => used.has(n),
      markUsed: (n) => used.add(n),
      now: new Date(`${testYear}-01-02T10:01:00+08:00`),
    });
    check("第二次生成 A0002", r.fileNo === `IN/NP/99999/A0002/${testYear}`, r.fileNo);
  }
  {
    resetCounters();
    const fetchRecover = makeFetch({
      accountCode: "A1",
      recoveryRows: [{ field73: `IN/NP/10073/B0001/${testYear}` }],
    });
    const r = await generateForCustomer({
      customerName: "Y",
      zohoFetch: fetchRecover,
      isFileNoUsed: () => false,
      markUsed: () => {},
      dryRun: true,
      now: new Date(`${testYear}-01-02T10:00:00+08:00`),
    });
    check("dryRun 不推进 DB 也能算出恢复后的下一号", r.segment === "B0002", `segment=${r.segment}`);
  }
  {
    let threw = false;
    try {
      await generateForCustomer({
        customerName: "Missing",
        zohoFetch: makeFetch({ accountCode: null }),
        isFileNoUsed: () => false,
        markUsed: () => {},
      });
    } catch (e) {
      threw = /未找到客户编号/.test(e.message);
    }
    check("Accounts 查不到 → 直接抛错（不再 TMP）", threw);
  }
  {
    const cache = new Map();
    let calls = 0;
    const fetchCount = async (url) => {
      if (url.startsWith("/Accounts/search")) calls++;
      return makeFetch({ accountCode: "A1" })(url);
    };
    await generateForCustomer({ customerName: "K", zohoFetch: fetchCount, isFileNoUsed: () => false, markUsed: () => {}, customerCodeCache: cache, dryRun: true });
    await generateForCustomer({ customerName: "K", zohoFetch: fetchCount, isFileNoUsed: () => false, markUsed: () => {}, customerCodeCache: cache, dryRun: true });
    check("customerCodeCache 命中只查 1 次 Accounts", calls === 1);
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
  try { fs.rmSync(tmpDbDir, { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
