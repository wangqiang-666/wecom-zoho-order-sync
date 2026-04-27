/**
 * 多表多场景闭环测试 —— 跨子表并行同步 + 冲突检测验证
 *
 * 场景：
 *   A. 多表正常并行：CS_Erik / CS_Krystal 各插一条独立订单 → 都同步到 ZOHO，file_no 不重号
 *   B. 跨表订单号冲突：CS_Erik / CS_Krystal 都填同一个订单号 → 双方均标失败，不写 ZOHO
 *   C. 冲突解除：把 CS_Krystal 那条改个号 → 下一轮恢复正常
 *
 * 用法：
 *   node scripts/test-multi-sheet-loop.js seed       # 注入测试数据
 *   node scripts/test-multi-sheet-loop.js sync       # 触发一轮同步
 *   node scripts/test-multi-sheet-loop.js verify     # 看 DB+ZOHO 状态
 *   node scripts/test-multi-sheet-loop.js cleanup    # 删除企微测试行
 *
 * 全自动闭环：
 *   node scripts/test-multi-sheet-loop.js all
 */

require("dotenv").config();
const config = require("../src/config");
const sheet = require("../src/services/wecom-sheet");
const { db } = require("../src/utils/db");
const { runOnce } = require("../src/jobs/sync-job");
const { zohoFetch } = require("../src/services/zoho-write");

const TAG = "TEST-MS-20260422";  // multi-sheet test prefix
const NORMAL_ERIK    = `${TAG}-A1`;   // CS_Erik 独立订单
const NORMAL_KRYSTAL = `${TAG}-A2`;   // CS_Krystal 独立订单
const CONFLICT       = `${TAG}-B`;    // 两表共用此号

async function getToken() {
  const j = await (await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${config.wecom.corpId}&corpsecret=${config.wecom.agentSecret}`
  )).json();
  if (j.errcode !== 0) throw new Error(j.errmsg);
  return j.access_token;
}
async function api(p, b) {
  const t = await getToken();
  const r = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/wedoc/smartsheet/${p}?access_token=${t}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  const j = await r.json();
  if (j.errcode !== 0) throw new Error(`${p}: ${j.errmsg}`);
  return j;
}

// 拿某子表某 Reference 字段的第一个可用 record_id（不同子表的 渠道名称 字典不同）
async function firstRefId(sheetMeta, fieldTitle) {
  const field = sheetMeta.fieldByTitle[fieldTitle];
  const subId = field?.property_reference?.sub_id;
  if (!subId) throw new Error(`[${sheetMeta.title}] 字段「${fieldTitle}」不是 Reference 或没有 sub_id`);
  const j = await api("get_records", {
    docid: config.wecom.sheet.docid, sheet_id: subId,
    key_type: "CELL_VALUE_KEY_TYPE_FIELD_TITLE",
    offset: 0, limit: 1,
  });
  const rid = j.records?.[0]?.record_id;
  if (!rid) throw new Error(`[${sheetMeta.title}] 字段「${fieldTitle}」字典 sub_id=${subId} 为空`);
  return rid;
}

function pickSelectByText(sheetMeta, fieldTitle, text) {
  const f = sheetMeta.fieldByTitle[fieldTitle];
  const opts = f?.property_single_select?.options || [];
  const hit = opts.find((o) => o.text === text);
  if (!hit) throw new Error(`[${sheetMeta.title}] 字段「${fieldTitle}」没有选项「${text}」`);
  return { id: hit.id, style: hit.style, text: hit.text };
}

async function buildRow(sheetMeta, orderNo, owner, suffix) {
  // 每个子表的 Reference 字典 record_id 动态拉（不同同事 渠道名称 字典独立）
  const refFields = ["渠道名称", "1业务类型", "业务细类", "1公证书使用地", "1证词出具地", "2证词模版", "4内容要求"];
  const refValues = {};
  for (const ft of refFields) {
    refValues[ft] = [await firstRefId(sheetMeta, ft)];
  }
  // SINGLE_SELECT 选项 id 也按 text 动态查（不同子表 option id 不同）
  const supplier = pickSelectByText(sheetMeta, "供应商", "區律师");
  const dropDisclaimer = pickSelectByText(sheetMeta, "删除不负责证词", "是");
  return {
    "订单确认编号":   [{ type: "text", text: orderNo }],
    "公证主体中文名":  [{ type: "text", text: `多表测试-${suffix}` }],
    "公证主体英文名":  [{ type: "text", text: `MultiSheet Test ${suffix}` }],
    "第几单":         [{ type: "text", text: "01" }],
    "文件存放路径":    [{ type: "text", text: `Z:\\test\\${orderNo}` }],
    "其他注意事项":    [{ type: "text", text: "无" }],
    "需递交文件名":    [{ type: "text", text: "无" }],
    "文案":           [{ type: "text", text: `测试文案${suffix}` }],
    "总页数":         [{ type: "text", text: "5" }],
    "彩打页数":        [{ type: "text", text: "0" }],
    "10订单金额":      [{ type: "text", text: "888" }],
    "业务员":      [{ type: "text", text: owner }],
    "订单所有者":      [{ type: "text", text: owner }],
    "7签字盖章":       [{ type: "text", text: "无" }],
    "9附件数量": 1,
    "供应商":        [supplier],
    "删除不负责证词":  [dropDisclaimer],
    ...refValues,
    "订单日期": "1766505600000",
  };
}

async function getSheetMeta(title) {
  await sheet.initMeta();
  const m = [...sheet._sheetMetas.values()].find((x) => x.title === title);
  if (!m) throw new Error(`找不到子表: ${title}`);
  return m;
}

async function addRow(sheetTitle, orderNo, owner, suffix) {
  const m = await getSheetMeta(sheetTitle);
  const values = await buildRow(m, orderNo, owner, suffix);
  const r = await api("add_records", {
    docid: config.wecom.sheet.docid,
    sheet_id: m.sheetId,
    key_type: "CELL_VALUE_KEY_TYPE_FIELD_TITLE",
    records: [{ values }],
  });
  const recId = r.records?.[0]?.record_id;
  console.log(`  + [${sheetTitle}] 插入 ${orderNo} → record_id=${recId}`);
  return recId;
}

async function listMyTestRows(sheetTitle) {
  const m = await getSheetMeta(sheetTitle);
  const j = await api("get_records", {
    docid: config.wecom.sheet.docid, sheet_id: m.sheetId,
    key_type: "CELL_VALUE_KEY_TYPE_FIELD_TITLE",
    offset: 0, limit: 500,
  });
  return (j.records || [])
    .map((r) => ({
      record_id: r.record_id,
      orderNo: (r.values["订单确认编号"]?.[0]?.text) || "",
      status: (r.values["导入状态"]?.[0]?.text) || "",
    }))
    .filter((r) => r.orderNo.startsWith(TAG));
}

async function deleteByRecordIds(sheetTitle, recordIds) {
  if (!recordIds.length) return;
  const m = await getSheetMeta(sheetTitle);
  await api("delete_records", {
    docid: config.wecom.sheet.docid, sheet_id: m.sheetId,
    record_ids: recordIds,
  });
}

// =================================================================
// 操作命令
// =================================================================

async function retryable(fn, attempts = 3, gap = 1500) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      console.log(`    (retry ${i+1}/${attempts}) ${e.message}`);
      await new Promise((r) => setTimeout(r, gap));
    }
  }
  throw last;
}

async function seed() {
  console.log("\n=== Seed: 注入 4 条测试行（场景 A + B）===");
  await retryable(() => addRow("CS_Erik",    NORMAL_ERIK,    "Erik",    "Erik独立"));
  await retryable(() => addRow("CS_Krystal", NORMAL_KRYSTAL, "Krystal", "Krystal独立"));
  // 冲突对：CS_Erik 和 CS_Krystal 都填同号
  await retryable(() => addRow("CS_Erik",    CONFLICT,       "Erik",    "冲突-Erik侧"));
  await retryable(() => addRow("CS_Krystal", CONFLICT,       "Krystal", "冲突-Krystal侧"));
}

async function sync() {
  console.log("\n=== Sync: 触发一轮 runOnce ===");
  process.env.SYNC_ORDER_NO_WHITELIST_PREFIX = TAG;  // 仅处理本测试行
  const r = await runOnce();
  console.log("结果:", r);
}

async function verify() {
  console.log("\n=== Verify: DB + ZOHO 状态对账 ===");

  // DB 端
  const dbRows = db.prepare(
    "SELECT row_id, business_key, status, zoho_id, file_no, last_error FROM sync_state WHERE business_key LIKE ? ORDER BY business_key, row_id"
  ).all(`${TAG}%`);
  console.log("\n[DB sync_state]");
  for (const r of dbRows) {
    const sheetId = r.row_id.split("::")[1];
    const meta = [...sheet._sheetMetas.values()].find((m) => m.sheetId === sheetId);
    const sheetTitle = meta?.title || sheetId;
    console.log(`  ${sheetTitle.padEnd(12)} ${r.business_key.padEnd(20)} ${r.status.padEnd(7)} zoho=${(r.zoho_id||"-").padEnd(20)} file_no=${r.file_no||"-"}`);
    if (r.last_error) console.log(`    err: ${r.last_error.slice(0, 100)}`);
  }

  // 企微表格 status 列
  console.log("\n[企微表格 导入状态 列]");
  for (const sheetTitle of ["CS_Erik", "CS_Krystal"]) {
    const rows = await listMyTestRows(sheetTitle);
    for (const r of rows) {
      console.log(`  ${sheetTitle.padEnd(12)} ${r.orderNo.padEnd(20)} ${r.status}`);
    }
  }

  // ZOHO 端
  console.log("\n[ZOHO 端]");
  const zohoIds = dbRows.filter((r) => r.zoho_id).map((r) => r.zoho_id);
  for (const id of zohoIds) {
    try {
      const r = await zohoFetch(`/CustomModule18/${id}`);
      const rec = r.data[0];
      console.log(`  zoho=${id} field235=${rec.field235} field73=${rec.field73} Name=${rec.Name}`);
    } catch (e) {
      console.log(`  zoho=${id} ❌ 查询失败: ${e.message}`);
    }
  }

  // 唯一性断言
  console.log("\n[断言]");
  const fileNos = dbRows.filter((r) => r.file_no).map((r) => r.file_no);
  const fnSet = new Set(fileNos);
  console.log(`  file_no 唯一性: ${fnSet.size === fileNos.length ? "✅" : "❌ 有重复"} (${fileNos.length} 条)`);

  const conflictRows = dbRows.filter((r) => r.business_key === CONFLICT);
  console.log(`  冲突号 ${CONFLICT}: ${conflictRows.length} 条`);
  const allFailed = conflictRows.length === 2 && conflictRows.every((r) => r.status === "failed" && !r.zoho_id);
  console.log(`  → 两条都失败且未写 ZOHO: ${allFailed ? "✅" : "❌"}`);

  const normalRows = dbRows.filter((r) => r.business_key === NORMAL_ERIK || r.business_key === NORMAL_KRYSTAL);
  const allOk = normalRows.length === 2 && normalRows.every((r) => r.status === "ok" && r.zoho_id && r.file_no);
  console.log(`  独立行 ${NORMAL_ERIK}/${NORMAL_KRYSTAL}: ${normalRows.length} 条 → 都 ok 且有 zoho+file_no: ${allOk ? "✅" : "❌"}`);
}

async function cleanup() {
  console.log("\n=== Cleanup: 删除企微测试行 ===");
  for (const sheetTitle of ["CS_Erik", "CS_Krystal"]) {
    const rows = await listMyTestRows(sheetTitle);
    if (rows.length) {
      await deleteByRecordIds(sheetTitle, rows.map((r) => r.record_id));
      console.log(`  删除 [${sheetTitle}] ${rows.length} 行`);
    }
  }
  // DB 状态保留供查阅
  console.log("  DB 状态保留（业务上是孤儿，下一轮 purgeOrphans 会处理 failed 行）");
}

(async () => {
  const cmd = process.argv[2] || "all";
  if (cmd === "seed") await seed();
  else if (cmd === "sync") await sync();
  else if (cmd === "verify") await verify();
  else if (cmd === "cleanup") await cleanup();
  else if (cmd === "all") {
    await cleanup();   // 先清干净
    await seed();
    await new Promise((r) => setTimeout(r, 2000));
    await sync();
    await verify();
    console.log("\n🎯 闭环测试结束。要清理企微行执行: node scripts/test-multi-sheet-loop.js cleanup");
  } else {
    console.error(`未知命令: ${cmd}. 可用: seed/sync/verify/cleanup/all`);
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => { console.error(e.stack); process.exit(1); });
