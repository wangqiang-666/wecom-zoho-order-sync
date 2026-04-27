// 完整流程验证：手动在企微 UI 新建 → 等待同步 → 检查 ZOHO
// 由于企微 API 插入有问题，这个脚本只做检查，需要你手动在企微 UI 里新建记录

const db = require('../src/utils/db');
const { zohoFetch } = require('../src/services/zoho-write');
const config = require('../src/config');

async function main() {
  console.log('=== 完整流程验证（需手动在企微 UI 新建记录）===\n');

  console.log('[1] 请在企微 UI 里手动新建 5 行测试数据：');
  console.log('    - 表：CS_Erik 或 CS_Echo 或 CS_Krystal');
  console.log('    - 公证主体中文名：验证测试1 ~ 验证测试5');
  console.log('    - 渠道名称：深圳市瑞安信进出口有限公司');
  console.log('    - 其他必填字段都填上');
  console.log('');
  console.log('    新建完成后，按回车继续...');

  // 等待用户输入
  await new Promise(resolve => {
    process.stdin.once('data', () => resolve());
  });

  console.log('\n[2] 等待 90 秒让系统自动同步...');
  await new Promise(r => setTimeout(r, 90000));

  console.log('\n[3] 查询 DB 里最近 10 条记录:');
  const rows = db.db.prepare(`
    SELECT row_id, business_key, file_no, zoho_id, status,
           datetime(updated_at/1000,'unixepoch','localtime') as updated
    FROM sync_state
    ORDER BY updated_at DESC
    LIMIT 10
  `).all();

  console.log('');
  for (const row of rows) {
    const parts = (row.file_no || '').split('/');
    const rand = parts[3] || '?';
    const flag = rand.length === 5 ? '✅' : (rand.length === 1 ? '❌' : '⚠️');
    console.log(`${flag} ${row.updated}  file_no=${row.file_no}  随机段="${rand}"`);
    console.log(`   zoho_id=${row.zoho_id}  status=${row.status}`);
  }

  console.log('\n[4] 查询 ZOHO 里这些记录的 field73:');
  const zohoIds = rows.filter(r => r.zoho_id).map(r => r.zoho_id);
  let matched = 0, mismatched = 0;

  for (const row of rows.filter(r => r.zoho_id)) {
    const r = await zohoFetch(`/${config.zoho.moduleApiName}/${row.zoho_id}?fields=id,Name,field73`);
    const rec = r.data && r.data[0];
    if (rec) {
      const dbParts = (row.file_no || '').split('/');
      const dbRand = dbParts[3] || '?';
      const zohoParts = (rec.field73 || '').split('/');
      const zohoRand = zohoParts[3] || '?';
      const match = zohoRand === dbRand;
      const flag = match ? '✅' : '❌';

      console.log(`\n  ${flag} Name=${rec.Name}  zoho_id=${row.zoho_id}`);
      console.log(`      DB:   ${row.file_no}  随机段="${dbRand}"`);
      console.log(`      ZOHO: ${rec.field73}  随机段="${zohoRand}"`);

      if (match) {
        matched++;
      } else {
        mismatched++;
        console.log(`      ^^^ 不匹配！ZOHO 被改了`);
      }
    }
  }

  console.log('\n[5] 汇总结果:');
  console.log(`  总计: ${matched + mismatched} 条`);
  console.log(`  ✅ 匹配: ${matched} 条`);
  console.log(`  ❌ 不匹配: ${mismatched} 条`);

  if (mismatched > 0) {
    console.log('\n🚨 还有异常！ZOHO workflow 可能还有问题');
    process.exit(1);
  } else {
    console.log('\n✅ 全部匹配！ZOHO workflow 修复成功！');
    process.exit(0);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
