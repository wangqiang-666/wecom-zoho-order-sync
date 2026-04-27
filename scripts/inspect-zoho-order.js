// 查 ZOHO 里 I-202681829 这条记录的 field73 + 字段历史
const { zohoFetch } = require('../src/services/zoho-write');
const config = require('../src/config');

async function main() {
  const orderNo = process.argv[2] || 'I-202681829';
  console.log(`查询订单号: ${orderNo}`);

  // 1. 按 Name 搜索（Name 通常是主显示字段）
  const tries = ['Name', 'field235', 'field73'];
  let rec = null;
  let hitField = null;
  for (const f of tries) {
    try {
      const c = `(${f}:equals:${orderNo})`;
      const data = await zohoFetch(`/${config.zoho.moduleApiName}/search?criteria=${encodeURIComponent(c)}`);
      if (data.data && data.data[0]) {
        rec = data.data[0];
        hitField = f;
        break;
      }
    } catch (e) {
      console.log(`  ${f} 搜索失败: ${e.message.slice(0,80)}`);
    }
  }

  if (!rec) {
    console.log('❌ 没找到该记录');
    process.exit(1);
  }

  console.log(`✅ 命中字段=${hitField}  zoho_id=${rec.id}`);
  console.log(`字段值：`);
  console.log(`  Name      = ${JSON.stringify(rec.Name)}`);
  console.log(`  field73   = ${JSON.stringify(rec.field73)}   ← 文件编号`);
  console.log(`  field235  = ${JSON.stringify(rec.field235)}  ← 订单确认编号`);
  console.log(`  Created_Time  = ${rec.Created_Time}`);
  console.log(`  Modified_Time = ${rec.Modified_Time}`);
  console.log(`  Created_By    = ${JSON.stringify(rec.Created_By)}`);
  console.log(`  Modified_By   = ${JSON.stringify(rec.Modified_By)}`);

  // 2. DB 里有没有这条
  const db = require('../src/utils/db');
  const dbRow = db.db.prepare("SELECT * FROM sync_state WHERE zoho_id = ?").get(rec.id);
  console.log(`\nDB sync_state:`);
  if (dbRow) {
    console.log(`  row_id   = ${dbRow.row_id}`);
    console.log(`  file_no  = ${dbRow.file_no}   ← 我们当初发出去的`);
    console.log(`  zoho_id  = ${dbRow.zoho_id}`);
    console.log(`  status   = ${dbRow.status}`);
    console.log(`  attempts = ${dbRow.attempts}`);
    console.log(`  updated_at = ${new Date(dbRow.updated_at).toLocaleString()}`);
  } else {
    console.log(`  ❌ DB 里没有这条`);
  }

  // 3. 拿字段修改历史（Notes/timeline API）
  console.log(`\n尝试取字段修改 timeline ...`);
  try {
    const timeline = await zohoFetch(`/${config.zoho.moduleApiName}/${rec.id}/__timeline?related_modules=Field_History`);
    const history = (timeline.__timeline || []).filter(e =>
      JSON.stringify(e).includes('field73')
    );
    if (history.length === 0) {
      console.log('  field73 没有 timeline 历史（可能创建后就一直是这个值，或权限不允许查）');
    } else {
      console.log(`  field73 timeline: ${JSON.stringify(history, null, 2)}`);
    }
  } catch (e) {
    console.log(`  timeline 查询失败: ${e.message.slice(0, 200)}`);
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
