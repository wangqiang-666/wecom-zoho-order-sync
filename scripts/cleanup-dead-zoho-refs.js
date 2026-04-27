/**
 * 一次性修复：DB 里 zoho_id 在 ZOHO 端已删 → 清 DB 记录 + 清企微状态列
 * 让下一轮 sync 把这些行作为"新订单"重新写入 ZOHO。
 */
require("dotenv").config();
const config = require("../src/config");
const sheet = require("../src/services/wecom-sheet");
const { zohoFetch } = require("../src/services/zoho-write");
const db = require("../src/utils/db");

(async () => {
  await sheet.initMeta();
  const meta = sheet._meta;

  const rows = db.db.prepare("SELECT row_id, zoho_id FROM sync_state WHERE status='ok' AND zoho_id IS NOT NULL").all();
  console.log(`检查 ${rows.length} 个已同步记录在 ZOHO 端是否有效...`);

  const dead = [];
  for (const r of rows) {
    const got = await zohoFetch(`/${config.zoho.moduleApiName}/${r.zoho_id}`);
    const rec = got.data?.[0];
    if (!rec || !rec.Name) {
      dead.push(r);
      console.log(`  💀 ${r.row_id}  zoho=${r.zoho_id}  (Name/Owner 都是 undefined)`);
    } else {
      console.log(`  ✅ ${r.row_id}  zoho=${r.zoho_id}  Name=${rec.Name}`);
    }
  }
  console.log(`\n死记录: ${dead.length}`);
  if (!dead.length) return;

  for (const r of dead) {
    const recordId = r.row_id.split("::").pop();
    // 1) 清企微状态列
    try {
      await sheet.updateStatus(r.row_id, "", ""); // 写空文本
      console.log(`  🧹 已清企微状态: ${recordId}`);
    } catch (e) {
      console.log(`  ⚠ 清企微状态失败: ${recordId} ${e.message}`);
    }
    // 2) 删 DB 记录
    db.db.prepare("DELETE FROM sync_state WHERE row_id = ?").run(r.row_id);
    console.log(`  🗑 已删 DB: ${r.row_id}`);
  }
  console.log(`\n✅ 完成。下一轮 sync 这些行会作为新订单重新创建`);
})().catch(e => { console.error("💥", e.message); process.exit(1); });
