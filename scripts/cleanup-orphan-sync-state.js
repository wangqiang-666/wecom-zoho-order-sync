/**
 * 清理 sync_state 里的"幽灵记录"：
 *   1) 状态=ok 但 ZOHO 端已删除 → 删本地记录
 *   2) row_id 在企微表格已不存在(行被删) → 删本地记录
 *
 * 用法：
 *   node scripts/cleanup-orphan-sync-state.js          # dry-run
 *   node scripts/cleanup-orphan-sync-state.js --apply  # 真正删
 */
require("dotenv").config();
const config = require("../src/config");
const db = require("../src/utils/db");
const sheet = require("../src/services/wecom-sheet");
const { zohoFetch } = require("../src/services/zoho-write");

const APPLY = process.argv.includes("--apply");

let _tok = null, _exp = 0;
async function getToken() {
  if (_tok && Date.now() < _exp) return _tok;
  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${config.wecom.corpId}&corpsecret=${config.wecom.agentSecret}`;
  const j = await (await fetch(url)).json();
  _tok = j.access_token; _exp = Date.now() + (j.expires_in - 300) * 1000;
  return _tok;
}

(async () => {
  console.log(`模式: ${APPLY ? "🔴 真删" : "🟢 dry-run"}`);

  // 1) 拉取企微表格所有 record_id
  await sheet.initMeta();
  const meta = sheet._meta;
  const wecomIds = new Set();
  let offset = 0;
  for (let safety = 0; safety < 100; safety++) {
    const tok = await getToken();
    const r = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/wedoc/smartsheet/get_records?access_token=${tok}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ docid: meta.docid, sheet_id: meta.sheetId, key_type: "CELL_VALUE_KEY_TYPE_FIELD_TITLE", offset, limit: 200 }),
    });
    const j = await r.json();
    if (j.errcode !== 0) throw new Error(j.errmsg);
    (j.records || []).forEach(x => wecomIds.add(x.record_id));
    if (!j.has_more || !j.records?.length) break;
    offset += j.records.length;
  }
  console.log(`📋 企微表格当前活跃 record_id: ${wecomIds.size}`);

  // 2) 拉本地 sync_state 全表
  const all = db.db.prepare("SELECT row_id, zoho_id, status, business_key FROM sync_state").all();
  console.log(`💾 本地 sync_state: ${all.length}`);

  const toDel = { wecomGone: [], zohoGone: [] };

  for (const r of all) {
    const recId = r.row_id.split("::").pop();
    if (!wecomIds.has(recId)) {
      toDel.wecomGone.push(r);
    }
  }

  // 3) 对剩下还在企微表格里、且本地有 zoho_id 的，逐个反查 ZOHO 是否还存在
  const stillAlive = all.filter(r => wecomIds.has(r.row_id.split("::").pop()) && r.zoho_id);
  console.log(`🔍 检查 ${stillAlive.length} 个 zoho_id 在 ZOHO 端是否存在...`);

  for (let i = 0; i < stillAlive.length; i++) {
    const r = stillAlive[i];
    try {
      await zohoFetch(`/${config.zoho.moduleApiName}/${r.zoho_id}`);
    } catch (e) {
      // 404 => 已删
      if (/HTTP 404/.test(e.message) || /INVALID_DATA/.test(e.message) || /id given seems to be invalid/.test(e.message)) {
        toDel.zohoGone.push(r);
      } else {
        console.log(`  ⚠ ${r.row_id} 反查异常: ${e.message.slice(0,100)}`);
      }
    }
    if ((i + 1) % 20 === 0) console.log(`  ...已检查 ${i+1}/${stillAlive.length}`);
  }

  console.log(`\n结果：`);
  console.log(`  企微行已不存在: ${toDel.wecomGone.length}`);
  console.log(`  ZOHO 已删除:     ${toDel.zohoGone.length}`);

  if (toDel.wecomGone.length || toDel.zohoGone.length) {
    console.log(`\n样例:`);
    [...toDel.wecomGone.slice(0,3), ...toDel.zohoGone.slice(0,3)].forEach(r => {
      console.log(`  ${r.row_id}  zoho=${r.zoho_id}  status=${r.status}  bk=${r.business_key}`);
    });
  }

  if (!APPLY) {
    console.log(`\n💡 dry-run 完成。加 --apply 真正删除`);
    return;
  }

  const delStmt = db.db.prepare("DELETE FROM sync_state WHERE row_id = ?");
  const tx = db.db.transaction((rows) => {
    for (const r of rows) delStmt.run(r.row_id);
  });
  tx([...toDel.wecomGone, ...toDel.zohoGone]);
  console.log(`✅ 已删除 ${toDel.wecomGone.length + toDel.zohoGone.length} 条`);
})().catch(e => { console.error("💥", e.message); process.exit(1); });
