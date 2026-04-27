/**
 * 失败通知去抖验证
 *
 * 语义：只有"内容改动"才算真人工介入（清状态列不算 —— 还是同一份坏数据）
 *   - 跑 7 轮 runOnce（每轮前清状态列，模拟同事手动要求重试）
 *   - 期望：第 1-5 轮入通知队列；第 6-7 轮静默（内容没变，持续累加）
 *   - Phase 3: 改一个内容字段（如"其他注意事项"）→ hash 变 → 计数重置 → 再失败入队
 *
 * 用法：node scripts/test-notify-throttle.js [--no-cleanup]
 */

require("dotenv").config();
const config = require("../src/config");
const sheet = require("../src/services/wecom-sheet");
const { db } = require("../src/utils/db");

const TAG = `THROTTLE-${Date.now().toString().slice(-6)}`;
const ORDER_NO = `${TAG}-FAIL`;
const STATE = { recId: null };

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
async function getSheetMeta(title) {
  await sheet.initMeta();
  const m = [...sheet._sheetMetas.values()].find((x) => x.title === title);
  if (!m) throw new Error(`找不到子表: ${title}`);
  return m;
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
function pickSelectByText(sm, fieldTitle, text) {
  const f = sm.fieldByTitle[fieldTitle];
  return (f?.property_single_select?.options || []).find((o) => o.text === text);
}

// 故意缺"文案"必填字段 → 永远校验失败
async function buildBadRow(sm) {
  const refFields = ["渠道名称", "1业务类型", "业务细类", "1公证书使用地", "1证词出具地", "2证词模版", "4内容要求"];
  const refValues = {};
  for (const ft of refFields) refValues[ft] = [await firstRefId(sm, ft)];
  const supplier = pickSelectByText(sm, "供应商", "區律师");
  const dropDis = pickSelectByText(sm, "删除不负责证词", "是");
  return {
    "订单确认编号":   [{ type: "text", text: ORDER_NO }],
    "公证主体中文名":  [{ type: "text", text: "去抖测试" }],
    "公证主体英文名":  [{ type: "text", text: "Throttle Test" }],
    "第几单":         [{ type: "text", text: "01" }],
    "文件存放路径":    [{ type: "text", text: "Z:\\throttle" }],
    "其他注意事项":    [{ type: "text", text: "无" }],
    "需递交文件名":    [{ type: "text", text: "无" }],
    // ⚠ 故意不填 "文案"
    "总页数":         [{ type: "text", text: "5" }],
    "彩打页数":        [{ type: "text", text: "0" }],
    "10订单金额":      [{ type: "text", text: "100" }],
    "业务员":      [{ type: "text", text: "Erik" }],
    "订单所有者":      [{ type: "text", text: "Erik" }],
    "7签字盖章":       [{ type: "text", text: "无" }],
    "9附件数量": 1,
    "供应商": [supplier],
    "删除不负责证词": [dropDis],
    ...refValues,
    "订单日期": "1766505600000",
  };
}

async function addBadRow() {
  const m = await getSheetMeta("CS_Erik");
  const values = await buildBadRow(m);
  const r = await wecomApi("add_records", {
    docid: config.wecom.sheet.docid, sheet_id: m.sheetId,
    key_type: "CELL_VALUE_KEY_TYPE_FIELD_TITLE",
    records: [{ values }],
  });
  return r.records[0].record_id;
}

async function clearStatusColumn(recordId) {
  const m = await getSheetMeta("CS_Erik");
  await wecomApi("update_records", {
    docid: config.wecom.sheet.docid, sheet_id: m.sheetId,
    key_type: "CELL_VALUE_KEY_TYPE_FIELD_TITLE",
    records: [{ record_id: recordId, values: { "导入状态": [{ type: "text", text: "" }] } }],
  });
}

async function modifyContent(recordId, text) {
  const m = await getSheetMeta("CS_Erik");
  await wecomApi("update_records", {
    docid: config.wecom.sheet.docid, sheet_id: m.sheetId,
    key_type: "CELL_VALUE_KEY_TYPE_FIELD_TITLE",
    records: [{ record_id: recordId, values: {
      "其他注意事项": [{ type: "text", text }],
      "导入状态": [{ type: "text", text: "" }],
    } }],
  });
}

async function deleteRow(recordId) {
  const m = await getSheetMeta("CS_Erik");
  await wecomApi("delete_records", {
    docid: config.wecom.sheet.docid, sheet_id: m.sheetId, record_ids: [recordId],
  });
}

function readDbState() {
  const r = db.prepare(
    "SELECT business_key, status, attempts, last_error FROM sync_state WHERE business_key = ?"
  ).get(ORDER_NO);
  return r;
}

function countPendingNotifies() {
  // 仅本次测试 TAG 相关的
  const rows = db.prepare(
    "SELECT id, payload FROM notify_queue WHERE sent_at IS NULL AND payload LIKE ?"
  ).all(`%${ORDER_NO}%`);
  return rows.length;
}

async function triggerSync(label) {
  process.env.SYNC_ORDER_NO_WHITELIST_PREFIX = TAG;
  // 每轮重新 require 拿到最新模块状态（_runOncePromise 复用没问题，重要的是 lock）
  const { runOnce } = require("../src/jobs/sync-job");
  const r = await runOnce();
  const st = readDbState();
  const pending = countPendingNotifies();
  console.log(`[${label}] runOnce → ok=${r.ok} failed=${r.failed} skipped=${r.skipped}; DB attempts=${st?.attempts ?? "-"} status=${st?.status ?? "-"}; pending_notify_for_this_row=${pending}`);
  return { runOnceResult: r, dbState: st, pendingNotifyCount: pending };
}

(async () => {
  try {
    console.log(`🧪 失败通知去抖测试 TAG=${TAG} ORDER_NO=${ORDER_NO}`);
    console.log(`   MAX_NOTIFY_ATTEMPTS=${config.poll.maxNotifyAttempts}`);

    console.log('\n=== Phase 1: 插入一条永远校验失败的行（缺「文案」）===');
    STATE.recId = await addBadRow();
    console.log(`  + [CS_Erik] 插入 ${ORDER_NO} → ${STATE.recId}`);
    await new Promise((r) => setTimeout(r, 1500));

    console.log("\n=== Phase 2: 跑 7 轮，每轮前清状态列（模拟同事反复重试），期望 1-5 轮入队，6-7 轮静默 ===");
    const phase2Counts = [];
    for (let i = 1; i <= 7; i++) {
      // 每轮跑前清状态列（模拟同事手动要求重试）
      if (i > 1) {
        await clearStatusColumn(STATE.recId);
        await new Promise((r) => setTimeout(r, 1500));
      }
      // 清掉已入队的（模拟通知已发出去），方便看每轮"新增"了几条
      db.prepare("UPDATE notify_queue SET sent_at = ? WHERE sent_at IS NULL AND payload LIKE ?")
        .run(Date.now(), `%${ORDER_NO}%`);
      const r = await triggerSync(`Round ${i}`);
      phase2Counts.push(r.pendingNotifyCount);
    }
    const expectedPhase2 = [1, 1, 1, 1, 1, 0, 0];  // 1-5 入队，6-7 静默
    const phase2Pass = JSON.stringify(phase2Counts) === JSON.stringify(expectedPhase2);
    console.log(`\n  Phase 2 每轮新增通知数：${phase2Counts.join(",")}  期望：${expectedPhase2.join(",")}  ${phase2Pass ? "✅" : "❌"}`);

    console.log("\n=== Phase 3: 改内容字段（模拟同事真改了东西）→ 期望计数重置 → 再失败入队 ===");
    await modifyContent(STATE.recId, `throttle-reset-${Date.now()}`);
    await new Promise((r) => setTimeout(r, 1500));
    db.prepare("UPDATE notify_queue SET sent_at = ? WHERE sent_at IS NULL AND payload LIKE ?")
      .run(Date.now(), `%${ORDER_NO}%`);
    const r8 = await triggerSync("Round 8 (改内容后)");
    const phase3Pass = r8.dbState?.attempts === 1 && r8.pendingNotifyCount === 1;
    console.log(`  Phase 3 attempts=${r8.dbState?.attempts}（期望 1） + 入队=${r8.pendingNotifyCount}（期望 1）  ${phase3Pass ? "✅" : "❌"}`);

    console.log("\n🎯 测试汇总");
    console.log("  失败 1-5 轮入队，6+ 静默：", phase2Pass ? "✅" : "❌");
    console.log("  改内容重置计数：         ", phase3Pass ? "✅" : "❌");

    if (!process.argv.includes("--no-cleanup")) {
      console.log("\n=== Cleanup ===");
      try { await deleteRow(STATE.recId); console.log(`  企微删 1 行`); } catch (e) { console.log(`  企微删失败: ${e.message}`); }
      const c = db.prepare("DELETE FROM sync_state WHERE business_key = ?").run(ORDER_NO).changes;
      const c2 = db.prepare("DELETE FROM notify_queue WHERE payload LIKE ?").run(`%${ORDER_NO}%`).changes;
      console.log(`  DB 清 sync_state ${c} 行 / notify_queue ${c2} 行`);
    } else {
      console.log("\n(--no-cleanup: 保留测试数据)");
    }
  } catch (e) {
    console.error("❌ 测试异常:", e.stack);
    process.exit(1);
  }
  process.exit(0);
})();
