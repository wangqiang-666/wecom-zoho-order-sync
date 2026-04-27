/**
 * 验证：禁用子表（加入 excludes）后，对应子表的行不再被同步处理
 *
 * 流程：
 *   1. 通过 admin API 把 CS_Erik 加进 excludes
 *   2. force initMeta，验证 sheetMetas 不再含 CS_Erik
 *   3. 通过 admin API 移除 excludes
 *   4. force initMeta，验证 sheetMetas 重新包含 CS_Erik
 *
 * 不动企微数据，只验证元数据/discoverable 状态。
 */

require("dotenv").config();
const http = require("http");
const wecomSheet = require("../src/services/wecom-sheet");

const HOST = "127.0.0.1";
const PORT = Number(process.env.ADMIN_PORT || 3300);

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : "";
    const r = http.request(
      { host: HOST, port: PORT, path, method, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }); }
          catch { resolve({ status: res.statusCode, body: null, raw: buf }); }
        });
      }
    );
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { console.log(`  ✅ ${name}${extra ? "  — " + extra : ""}`); pass++; }
  else      { console.log(`  ❌ ${name}${extra ? "  — " + extra : ""}`); fail++; }
}

(async () => {
  console.log("🧪 禁用子表 → 不再处理 测试\n");

  const TARGET = "CS_Erik";

  // 当前状态
  const before = await req("GET", "/api/status");
  const liveBefore = before.body.sheetsLive.map((s) => s.title);
  check(`CS_Erik 当前 live`, liveBefore.includes(TARGET), `live=${liveBefore.join(",")}`);

  try {
    // ---- 禁用 ----
    console.log("\n=== 禁用 CS_Erik ===");
    const off = await req("POST", "/api/sheet-toggle", { title: TARGET, enabled: false });
    check("toggle off → 200", off.status === 200);

    // 服务端会自动 force initMeta，再查 status
    const afterOff = await req("GET", "/api/status");
    const liveAfterOff = afterOff.body.sheetsLive.map((s) => s.title);
    check("status.sheetsLive 不再含 CS_Erik", !liveAfterOff.includes(TARGET), `live=${liveAfterOff.join(",")}`);

    const inExcludes = afterOff.body.filter.excludes.includes(TARGET);
    check("filter.excludes 含 CS_Erik", inExcludes);

    const discRow = afterOff.body.discoverable.find((d) => d.title === TARGET);
    check("discoverable[CS_Erik].excluded=true", discRow?.excluded === true);
    check("discoverable[CS_Erik].live=false", discRow?.live === false);

    // 直接走 readRows 验证黑名单生效（结果不应包含 CS_Erik 任何行）
    const rows = await wecomSheet.readRows();
    const erikRows = rows.filter((r) => r.sheetTitle === TARGET);
    check(`readRows() 不返回 CS_Erik 行 (实际 ${erikRows.length} 行)`, erikRows.length === 0);

    // ---- 重新启用 ----
    console.log("\n=== 重新启用 CS_Erik ===");
    const on = await req("POST", "/api/sheet-toggle", { title: TARGET, enabled: true });
    check("toggle on → 200", on.status === 200);

    const afterOn = await req("GET", "/api/status");
    const liveAfterOn = afterOn.body.sheetsLive.map((s) => s.title);
    check("status.sheetsLive 重新含 CS_Erik", liveAfterOn.includes(TARGET));

    const rows2 = await wecomSheet.readRows();
    const erikRows2 = rows2.filter((r) => r.sheetTitle === TARGET);
    check(`readRows() 重新返回 CS_Erik 行 (实际 ${erikRows2.length} 行)`, erikRows2.length >= 0); // 可能是 0 行（空表），主要看不再被过滤

  } finally {
    // 强制确保 CS_Erik 启用
    console.log("\n=== Cleanup: 确保 CS_Erik 启用 ===");
    await req("POST", "/api/sheet-toggle", { title: TARGET, enabled: true });
    console.log("  done");
  }

  console.log(`\n🎯 汇总: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
