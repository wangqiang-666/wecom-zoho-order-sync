/**
 * 端到端闭环测试 —— 覆盖 4 个场景
 *
 *   A. 正常多表并行插入：CS_Erik / CS_Krystal 各 1 条独立订单 → 全部同步到 ZOHO
 *   B. 跨表订单号冲突：两表同号 → 两条都失败不写 ZOHO
 *   C. 更新已同步：修改 A 场景的 Erik 行的"文案"字段 → 应触发 PUT 更新 ZOHO
 *   D. 失败自愈：B 场景中把 Krystal 这条改号（解冲突）→ 下一轮两条都应转 ok
 *
 * 流程：cleanup → seed → sync-1 → verify-1 → modify(场景C+D) → sync-2 → verify-2 → cleanup
 *
 * 触发方式：走 admin HTTP /api/run-now（真实链路，和 cron/callback 一致）
 */

require("dotenv").config();
const config = require("../src/config");
const sheet = require("../src/services/wecom-sheet");
const { db } = require("../src/utils/db");
const { zohoFetch } = require("../src/services/zoho-write");

const ADMIN_BASE = process.env.ADMIN_BASE || "http://127.0.0.1:3300";
const TAG = `E2E-${new Date().toISOString().slice(0,10).replace(/-/g,"")}-${String(Date.now()).slice(-4)}`;
const NORMAL_ERIK    = `${TAG}-A1`;
const NORMAL_KRYSTAL = `${TAG}-A2`;
const CONFLICT       = `${TAG}-B`;

const STATE = { erikRecId: null, krystalRecId: null, conflictErikRecId: null, conflictKrystalRecId: null };

// ---------- 企微 API ----------
async function getToken() {
  const j = await (await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${config.wecom.corpId}&corpsecret=${config.wecom.agentSecret}`
  )).json();
  if (j.errcode !== 0) throw new Error(j.errmsg);
  return j.access_token;
}
async function wecomApi(p, b) {
  const t = await getToken();
  const r = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/wedoc/smartsheet/${p}?access_token=${t}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  const j = await r.json();
  if (j.errcode !== 0) throw new Error(`${p}: ${j.errmsg}`);
  return j;
}
async function firstRefId(sm, fieldTitle) {
  const subId = sm.fieldByTitle[fieldTitle]?.property_reference?.sub_id;
  if (!subId) throw new Error(`${sm.title}/${fieldTitle} 非 Reference`);
  const j = await wecomApi("get_records", {
    docid: config.wecom.sheet.docid, sheet_id: subId,
    key_type: "CELL_VALUE_KEY_TYPE_FIELD_TITLE", offset: 0, limit: 1,
  });
  return j.records[0].record_id;
}
async function cellValue(sm, fieldTitle, text) {
  const f = sm.fieldByTitle[fieldTitle];
  if (f?.field_type === "FIELD_TYPE_REFERENCE") return [await firstRefId(sm, fieldTitle)];
  return [{ type: "text", text }];
}
function pickSelectByText(sm, fieldTitle, text) {
  const f = sm.fieldByTitle[fieldTitle];
  return (f?.property_single_select?.options || []).find((o) => o.text === text);
}

async function buildRow(sm, orderNo, owner, suffix) {
  const fieldValues = {};
  fieldValues["渠道名称"] = await cellValue(sm, "渠道名称", "深圳市环达商务服务有限公司");
  fieldValues["1业务类型"] = await cellValue(sm, "1业务类型", "个人文件");
  fieldValues["业务细类"] = await cellValue(sm, "业务细类", "声明");
  fieldValues["1公证书使用地"] = await cellValue(sm, "1公证书使用地", "香港");
  fieldValues["1证词出具地"] = await cellValue(sm, "1证词出具地", "香港");
  fieldValues["2证词模版"] = await cellValue(sm, "2证词模版", "标准");
  fieldValues["4内容要求"] = await cellValue(sm, "4内容要求", "无");
  const supplier = pickSelectByText(sm, "供应商", "區律师");
  const dropDis = pickSelectByText(sm, "删除不负责证词", "是");
  const confirmImport = pickSelectByText(sm, "是否确定导入", "导入");
  return {
    "订单确认编号":   [{ type: "text", text: orderNo }],
    "公证主体中文名":  [{ type: "text", text: `E2E测试-${suffix}` }],
    "公证主体英文名":  [{ type: "text", text: `E2E Test ${suffix}` }],
    "第几单":         [{ type: "text", text: "01" }],
    "文件存放路径":    [{ type: "text", text: `Z:\\e2e\\${orderNo}` }],
    "其他注意事项":    [{ type: "text", text: "无" }],
    "需递交文件名":    [{ type: "text", text: "无" }],
    "文案":           [{ type: "text", text: `E2E文案初始-${suffix}` }],
    "总页数":         [{ type: "text", text: "5" }],
    "彩打页数":        [{ type: "text", text: "0" }],
    "10订单金额":      [{ type: "text", text: "888" }],
    "订单导入者":      [{ type: "text", text: owner }],
    "订单所有者":      [{ type: "text", text: owner }],
    "7签字盖章":       [{ type: "text", text: "无" }],
    "9附件数量": 1,
    "供应商": [supplier],
    "删除不负责证词": [dropDis],
    "是否确定导入": [confirmImport],
    ...fieldValues,
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
  const r = await wecomApi("add_records", {
    docid: config.wecom.sheet.docid, sheet_id: m.sheetId,
    key_type: "CELL_VALUE_KEY_TYPE_FIELD_TITLE",
    records: [{ values }],
  });
  const recId = r.records[0].record_id;
  console.log(`  + [${sheetTitle}] 插入 ${orderNo} → ${recId}`);
  return recId;
}

async function updateRow(sheetTitle, recordId, values) {
  const m = await getSheetMeta(sheetTitle);
  await wecomApi("update_records", {
    docid: config.wecom.sheet.docid, sheet_id: m.sheetId,
    key_type: "CELL_VALUE_KEY_TYPE_FIELD_TITLE",
    records: [{ record_id: recordId, values }],
  });
}

async function listByTag(sheetTitle) {
  const m = await getSheetMeta(sheetTitle);
  const j = await wecomApi("get_records", {
    docid: config.wecom.sheet.docid, sheet_id: m.sheetId,
    key_type: "CELL_VALUE_KEY_TYPE_FIELD_TITLE",
    offset: 0, limit: 500,
  });
  return (j.records || [])
    .map((r) => ({
      record_id: r.record_id,
      orderNo: r.values["订单确认编号"]?.[0]?.text || "",
      wenAn: r.values["文案"]?.[0]?.text || "",
      status: r.values["导入状态"]?.[0]?.text || "",
    }))
    .filter((r) => r.orderNo.startsWith(TAG));
}

async function deleteByRecordIds(sheetTitle, recordIds) {
  if (!recordIds.length) return;
  const m = await getSheetMeta(sheetTitle);
  await wecomApi("delete_records", {
    docid: config.wecom.sheet.docid, sheet_id: m.sheetId, record_ids: recordIds,
  });
}

// ---------- 触发同步（直接调 runOnce，要求服务进程在测试期间停掉，避免锁竞争） ----------
async function triggerSync() {
  process.env.SYNC_ORDER_NO_WHITELIST_PREFIX = TAG;
  console.log(`  触发 runOnce (白名单 prefix=${TAG})...`);
  const { runOnce } = require("../src/jobs/sync-job");
  const r = await runOnce();
  if (r.skipped && r.reason === "locked") {
    throw new Error(`runOnce 被锁阻塞（服务进程持锁 pid=${r.heldBy?.pid}），请先停服务再跑测试：kill ${r.heldBy?.pid}`);
  }
  console.log("  结果:", r);
  return r;
}

// ---------- 断言 ----------
async function verifyDBRows(scenario) {
  console.log(`\n--- verify: ${scenario} ---`);
  const rows = db.prepare(
    "SELECT row_id, business_key, status, zoho_id, file_no, last_error, attempts FROM sync_state WHERE business_key LIKE ? ORDER BY business_key, row_id"
  ).all(`${TAG}%`);
  console.log("[DB sync_state]");
  for (const r of rows) {
    const sheetId = r.row_id.split("::")[1];
    const m = [...sheet._sheetMetas.values()].find((x) => x.sheetId === sheetId);
    const t = m?.title || sheetId;
    console.log(`  ${t.padEnd(12)} ${r.business_key.padEnd(24)} ${r.status.padEnd(7)} zoho=${(r.zoho_id||"-").padEnd(20)} file_no=${r.file_no||"-"} att=${r.attempts}`);
    if (r.last_error) console.log(`    ⚠ ${r.last_error.slice(0,120)}`);
  }

  console.log("\n[企微表格 导入状态]");
  for (const t of ["CS_Erik", "CS_Krystal"]) {
    for (const r of await listByTag(t)) {
      console.log(`  ${t.padEnd(12)} ${r.orderNo.padEnd(24)} 文案=${r.wenAn.slice(0,20).padEnd(20)} 状态=${r.status}`);
    }
  }
  return rows;
}

async function verifyZohoRecord(zohoId, expected = {}) {
  try {
    const r = await zohoFetch(`/${config.zoho.moduleApiName}/${zohoId}`);
    const rec = r.data[0];
    const out = {};
    for (const [field, value] of Object.entries(expected)) {
      out[field] = rec[field] === value;
    }
    return { ok: true, rec, matches: out };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------- 各场景 ----------
async function phase1_seed() {
  console.log("\n=== Phase 1: Seed (A+B 场景初始数据) ===");
  STATE.erikRecId          = await addRow("CS_Erik",    NORMAL_ERIK,    "Erik",    "Erik独立");
  STATE.krystalRecId       = await addRow("CS_Krystal", NORMAL_KRYSTAL, "Krystal", "Krystal独立");
  STATE.conflictErikRecId    = await addRow("CS_Erik",    CONFLICT, "Erik",    "冲突-E侧");
  STATE.conflictKrystalRecId = await addRow("CS_Krystal", CONFLICT, "Krystal", "冲突-K侧");
  await new Promise((r) => setTimeout(r, 1500));
}

async function phase2_assert_initial() {
  console.log("\n=== Phase 2: 验证首轮结果 ===");
  const rows = await verifyDBRows("初始同步");
  const normalOk = rows
    .filter((r) => r.business_key === NORMAL_ERIK || r.business_key === NORMAL_KRYSTAL)
    .every((r) => r.status === "ok" && r.zoho_id && r.file_no);
  const conflictFailed = rows.filter((r) => r.business_key === CONFLICT)
    .every((r) => r.status === "failed" && !r.zoho_id);

  // 检查 file_no 格式 + 唯一性
  const fileNos = rows.filter((r) => r.file_no).map((r) => r.file_no);
  const fileNoFormat = fileNos.every((fn) => /^IN\/NP\/[^/]+\/[A-Z0-9]{5}\/\d{4}$/.test(fn));
  const fileNoUnique = new Set(fileNos).size === fileNos.length;

  const zohoIds = rows.filter((r) => r.zoho_id).map((r) => r.zoho_id);
  const allZohoExist = [];
  for (const id of zohoIds) {
    const v = await verifyZohoRecord(id, {});
    allZohoExist.push({ id, exists: v.ok });
  }

  console.log("\n[Phase 2 断言]");
  console.log(`  独立行 ok+zoho+file_no: ${normalOk ? "✅" : "❌"}`);
  console.log(`  冲突行均 failed+无 zoho_id: ${conflictFailed ? "✅" : "❌"}`);
  console.log(`  file_no 格式 IN/NP/X/XXXXX/YYYY: ${fileNoFormat ? "✅" : "❌"} (${fileNos.join(",")})`);
  console.log(`  file_no 唯一: ${fileNoUnique ? "✅" : "❌"}`);
  console.log(`  ZOHO 记录可查: ${allZohoExist.every((x) => x.exists) ? "✅" : "❌"} ${JSON.stringify(allZohoExist)}`);

  return { normalOk, conflictFailed, fileNoFormat, fileNoUnique, zohoAllExist: allZohoExist.every((x) => x.exists), rows };
}

async function phase3_modify() {
  console.log("\n=== Phase 3: Modify (场景C+D) ===");
  // C. 改 Erik 独立订单的文案 → 触发更新
  await updateRow("CS_Erik", STATE.erikRecId, {
    "文案": [{ type: "text", text: "E2E文案已修改-触发更新" }],
    "导入状态": [{ type: "text", text: "" }],   // 清状态列，触发重试
  });
  console.log(`  ✏️  CS_Erik/${NORMAL_ERIK} 文案已改`);

  // D. 改冲突 Krystal 这条订单号（解冲突）
  const newKNo = `${CONFLICT}-K`;
  await updateRow("CS_Krystal", STATE.conflictKrystalRecId, {
    "订单确认编号": [{ type: "text", text: newKNo }],
    "导入状态":     [{ type: "text", text: "" }],
  });
  // Erik 这条也清状态（它上轮是 failed，要重试）
  await updateRow("CS_Erik", STATE.conflictErikRecId, {
    "导入状态": [{ type: "text", text: "" }],
  });
  console.log(`  ✏️  CS_Krystal 冲突号改为 ${newKNo}，双方状态列已清（触发重试）`);

  await new Promise((r) => setTimeout(r, 1500));
  return newKNo;
}

async function phase4_assert_updated(resolvedConflictK, phase2Rows) {
  console.log("\n=== Phase 4: 验证二轮结果 ===");
  // 白名单要扩展以覆盖新改的 CONFLICT-K
  process.env.SYNC_ORDER_NO_WHITELIST_PREFIX = TAG;
  const rows = await verifyDBRows("修改后");

  // C 断言：Erik 独立行仍然是同一个 zoho_id，status=ok，但 updated
  const p2Erik = phase2Rows.find((r) => r.business_key === NORMAL_ERIK);
  const p4Erik = rows.find((r) => r.business_key === NORMAL_ERIK);
  const sameZohoId = p2Erik?.zoho_id && p2Erik.zoho_id === p4Erik?.zoho_id;
  const sameFileNo = p2Erik?.file_no === p4Erik?.file_no;
  const isOk = p4Erik?.status === "ok";

  // 检查 ZOHO 那边的文案字段是否更新了
  let zohoWenAnUpdated = null;
  if (p4Erik?.zoho_id) {
    const r = await zohoFetch(`/${config.zoho.moduleApiName}/${p4Erik.zoho_id}`);
    const rec = r.data[0];
    // 文案字段的 ZOHO API 名称需要查 field-map —— 暂时直接打印全部字段里的"修改"
    zohoWenAnUpdated = JSON.stringify(rec).includes("E2E文案已修改");
    console.log(`  [ZOHO ${p4Erik.zoho_id}] 文案包含"已修改": ${zohoWenAnUpdated ? "✅" : "❌"}`);
  }

  // D 断言：两条冲突行都变成 ok
  const eriK = rows.find((r) => r.business_key === CONFLICT);
  const krys = rows.find((r) => r.business_key === resolvedConflictK);
  const conflictResolved = eriK?.status === "ok" && eriK?.zoho_id && krys?.status === "ok" && krys?.zoho_id;
  const differentZoho = eriK?.zoho_id !== krys?.zoho_id;

  console.log("\n[Phase 4 断言]");
  console.log(`  更新场景 C: Erik 行 zoho_id 不变=${sameZohoId ? "✅" : "❌"} file_no 不变=${sameFileNo ? "✅" : "❌"} status=ok=${isOk ? "✅" : "❌"}`);
  console.log(`  更新场景 C: ZOHO 文案已更新=${zohoWenAnUpdated ? "✅" : "❌"}`);
  console.log(`  自愈场景 D: 冲突解除后两条都 ok=${conflictResolved ? "✅" : "❌"} 不同 zoho_id=${differentZoho ? "✅" : "❌"}`);

  return { sameZohoId, sameFileNo, isOk, zohoWenAnUpdated, conflictResolved, differentZoho };
}

async function cleanup() {
  console.log("\n=== Cleanup ===");
  for (const t of ["CS_Erik", "CS_Krystal"]) {
    const rows = await listByTag(t);
    if (rows.length) {
      await deleteByRecordIds(t, rows.map((r) => r.record_id));
      console.log(`  删除 ${t} ${rows.length} 行`);
    }
  }
  // 清 ZOHO 测试记录
  const dbRows = db.prepare(
    "SELECT zoho_id FROM sync_state WHERE business_key LIKE ? AND zoho_id IS NOT NULL"
  ).all(`${TAG}%`);
  const ids = [...new Set(dbRows.map((r) => r.zoho_id))];
  if (ids.length) {
    try {
      const r = await zohoFetch(`/${config.zoho.moduleApiName}?ids=${ids.join(",")}`, { method: "DELETE" });
      console.log(`  ZOHO 批量删除 ${ids.length} 条:`, r.data?.map((d) => d.code).join(","));
    } catch (e) {
      console.log(`  ZOHO 删除失败: ${e.message}`);
    }
  }
  const delRows = db.prepare("DELETE FROM sync_state WHERE business_key LIKE ?").run(`${TAG}%`).changes;
  console.log(`  DB 清 ${delRows} 行`);
}

// ---------- main ----------
(async () => {
  try {
    console.log(`🧪 E2E 闭环测试开始 TAG=${TAG}`);
    console.log(`   Admin: ${ADMIN_BASE}`);

    await phase1_seed();
    await triggerSync();
    const p2 = await phase2_assert_initial();

    const resolvedK = await phase3_modify();
    await triggerSync();
    const p4 = await phase4_assert_updated(resolvedK, p2.rows);

    console.log("\n🎯 E2E 汇总");
    console.log("  初始多表并行(A):", p2.normalOk ? "✅" : "❌");
    console.log("  跨表冲突(B):    ", p2.conflictFailed ? "✅" : "❌");
    console.log("  file_no 格式:   ", p2.fileNoFormat ? "✅" : "❌");
    console.log("  file_no 唯一:   ", p2.fileNoUnique ? "✅" : "❌");
    console.log("  更新已同步(C):  ", p4.sameZohoId && p4.isOk && p4.zohoWenAnUpdated ? "✅" : "❌");
    console.log("  失败自愈(D):    ", p4.conflictResolved ? "✅" : "❌");

    if (process.argv.includes("--no-cleanup")) {
      console.log("\n(--no-cleanup: 保留测试数据供你检查)");
    } else {
      await cleanup();
    }
  } catch (e) {
    console.error("❌ 测试异常:", e.stack);
    process.exit(1);
  }
  process.exit(0);
})();
