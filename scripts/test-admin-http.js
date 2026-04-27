/**
 * admin HTTP 接口测试
 * 覆盖：
 *   GET  /health
 *   GET  /api/status
 *   GET  /api/required-fields
 *   POST /api/required-fields                  正常/空数组/非数组/未知字段/含锁定字段
 *   POST /api/required-fields/reset            清空 override
 *   POST /api/interval                         正常/<30/非法/极大
 *   POST /api/notify                           开/关/缺 body
 *   POST /api/sheet-toggle                     启用/禁用/空 title/CS_IT 启用
 *   POST /api/refresh-sheets
 *   POST /api/sheets                           legacy 自动发现
 *   POST /api/run-now                          立即触发
 *   404 未知路径、405 未支持 method
 *
 * 约定：测试前后保留原值（保存 → 改 → 改回），通过 DB 快照恢复。
 */

require("dotenv").config();
const http = require("http");
const db = require("../src/utils/db");
const runtimeConfig = require("../src/utils/runtime-config");
const logger = require("../src/utils/logger");

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
          let j = null;
          try { j = buf ? JSON.parse(buf) : null; } catch { /* keep raw */ }
          resolve({ status: res.statusCode, body: j, raw: buf });
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
  logger.info("🧪 admin HTTP 接口测试");

  // 保存原值
  const orig = {
    interval: runtimeConfig.getPollIntervalSec(),
    notify: runtimeConfig.isNotifyEnabled(),
    requiredOverride: runtimeConfig.getRequiredFieldsOverride(),
    excludes: db.db.prepare("SELECT value FROM app_config WHERE key='sheet_excludes'").get()?.value ?? null,
  };
  console.log("原值快照:", orig);

  try {
    // ---------- /health ----------
    console.log("\n=== /health ===");
    {
      const r = await req("GET", "/health");
      check("200 + ok:true", r.status === 200 && r.body?.ok === true);
    }

    // ---------- /api/status ----------
    console.log("\n=== /api/status ===");
    {
      const r = await req("GET", "/api/status");
      check("200 + docid 字段", r.status === 200 && typeof r.body?.docid === "string");
      check("filter 含 prefix+excludes", r.body?.filter?.prefix && Array.isArray(r.body?.filter?.excludes));
      check("discoverable 是数组", Array.isArray(r.body?.discoverable));
      check("CS_IT 永远在 excludes", r.body?.filter?.excludes?.includes("CS_IT"));
    }

    // ---------- /api/required-fields ----------
    console.log("\n=== /api/required-fields ===");
    {
      const r = await req("GET", "/api/required-fields");
      check("GET 200", r.status === 200);
      check("fields 非空数组", Array.isArray(r.body?.fields) && r.body.fields.length > 0);
      check("selected 含「主题」(locked)", r.body?.selected?.includes("主题"));
      check("不含导入状态(local)", !r.body?.fields?.some((f) => f.source === "导入状态"));
    }

    // POST 各场景
    {
      const r = await req("POST", "/api/required-fields", { selected: ["文案", "渠道名称"] });
      check("POST 正常", r.status === 200 && r.body?.selected?.includes("文案"));
      check("POST 自动 union 锁定字段", r.body?.selected?.includes("主题"));
    }
    {
      const r = await req("POST", "/api/required-fields", { selected: [] });
      check("POST 空数组仍保留锁定字段", r.status === 200 && r.body?.selected?.length === 1 && r.body.selected[0] === "主题");
    }
    {
      const r = await req("POST", "/api/required-fields", { selected: ["不存在的字段"] });
      check("POST 未知字段被过滤", r.status === 200 && !r.body?.selected?.includes("不存在的字段"));
    }
    {
      const r = await req("POST", "/api/required-fields", { selected: "not-array" });
      check("POST 非数组不崩溃", r.status === 200);
    }
    {
      const r = await req("POST", "/api/required-fields", {});
      check("POST 缺字段不崩溃", r.status === 200);
    }
    {
      const r = await req("POST", "/api/required-fields/reset", {});
      check("reset 200", r.status === 200 && r.body?.reset === true);
      const chk = runtimeConfig.getRequiredFieldsOverride();
      check("reset 后 getRequiredFieldsOverride()===null", chk === null);
    }

    // ---------- /api/interval ----------
    console.log("\n=== /api/interval ===");
    {
      const r = await req("POST", "/api/interval", { sec: 600 });
      check("POST 600 → 200", r.status === 200 && r.body?.sec === 600);
    }
    {
      const r = await req("POST", "/api/interval", { sec: 10 });
      check("POST 10 → 被提升到 30", r.status === 200 && r.body?.sec === 30);
    }
    {
      const r = await req("POST", "/api/interval", { sec: "abc" });
      check("POST 非数字 → 500 或非 200", r.status !== 200);
    }
    {
      const r = await req("POST", "/api/interval", { sec: 999999 });
      check("POST 极大值 → 200 (不限上限)", r.status === 200);
    }

    // ---------- /api/notify ----------
    console.log("\n=== /api/notify ===");
    {
      const r = await req("POST", "/api/notify", { enabled: true });
      check("POST 开启", r.status === 200 && r.body?.enabled === true);
    }
    {
      const r = await req("POST", "/api/notify", { enabled: false });
      check("POST 关闭", r.status === 200 && r.body?.enabled === false);
    }
    {
      const r = await req("POST", "/api/notify", {});
      check("POST 缺 body → 视为 false", r.status === 200 && r.body?.enabled === false);
    }

    // ---------- /api/sheet-toggle ----------
    console.log("\n=== /api/sheet-toggle ===");
    {
      const r = await req("POST", "/api/sheet-toggle", { title: "CS_TestBogus", enabled: false });
      check("禁用非存在子表 → 200（加黑名单）", r.status === 200);
      const filter = runtimeConfig.getSheetFilter();
      check("excludes 含新加的", filter.excludes.includes("CS_TestBogus"));
    }
    {
      const r = await req("POST", "/api/sheet-toggle", { title: "CS_TestBogus", enabled: true });
      check("重新启用 → 从 excludes 移除", r.status === 200);
      const filter = runtimeConfig.getSheetFilter();
      check("excludes 不再含", !filter.excludes.includes("CS_TestBogus"));
    }
    {
      const r = await req("POST", "/api/sheet-toggle", { title: "", enabled: true });
      check("空 title → 500", r.status === 500 && /必填/.test(r.body?.error || ""));
    }
    {
      const r = await req("POST", "/api/sheet-toggle", { title: "CS_IT", enabled: true });
      check("启用 CS_IT → 200 (前端 confirm 拦截，后端允许)", r.status === 200);
      // 但 DEFAULT_EXCLUDES 永久 union，getSheetFilter 仍把它黑名单
      const filter = runtimeConfig.getSheetFilter();
      check("CS_IT 永远在 excludes（DEFAULT_EXCLUDES union）", filter.excludes.includes("CS_IT"));
    }

    // ---------- /api/refresh-sheets ----------
    console.log("\n=== /api/refresh-sheets ===");
    {
      const r = await req("POST", "/api/refresh-sheets", {});
      check("POST 200", r.status === 200 && r.body?.ok === true);
    }

    // ---------- /api/sheets (legacy) ----------
    console.log("\n=== /api/sheets (legacy) ===");
    {
      const r = await req("POST", "/api/sheets", {});
      check("POST 200 + mode=auto-discover", r.status === 200 && r.body?.mode === "auto-discover");
    }

    // ---------- /api/run-now ----------
    console.log("\n=== /api/run-now ===");
    {
      const r = await req("POST", "/api/run-now", {});
      check("POST 200 + fired=true", r.status === 200 && r.body?.fired === true);
    }

    // ---------- 404 / 405 ----------
    console.log("\n=== 404 / 405 ===");
    {
      const r = await req("GET", "/api/does-not-exist");
      check("未知路径 → 404", r.status === 404);
    }
    {
      const r = await req("PUT", "/api/interval", { sec: 120 });
      check("PUT /api/interval → 404 (只接 POST)", r.status === 404);
    }

    // ---------- / root HTML ----------
    console.log("\n=== / HTML ===");
    {
      const r = await req("GET", "/");
      check("GET / → 200 + 含 HTML", r.status === 200 && /同步控制台/.test(r.raw));
    }

  } finally {
    // 恢复原值
    console.log("\n=== Cleanup: 恢复原值 ===");
    runtimeConfig.setPollIntervalSec(orig.interval);
    runtimeConfig.setNotifyEnabled(orig.notify);
    if (orig.requiredOverride === null) runtimeConfig.resetRequiredFieldsOverride();
    else runtimeConfig.setRequiredFieldsOverride(orig.requiredOverride);
    if (orig.excludes === null) db.db.prepare("DELETE FROM app_config WHERE key='sheet_excludes'").run();
    else db.setConfig("sheet_excludes", orig.excludes);
    console.log("  已恢复");
  }

  console.log(`\n🎯 汇总: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
