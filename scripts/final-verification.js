// 完整流程测试：插入真实可读的数据 → 同步 → 验证 ZOHO（不删除）
const sheet = require('../src/services/wecom-sheet');
const syncJob = require('../src/jobs/sync-job');
const db = require('../src/utils/db');
const { zohoFetch } = require('../src/services/zoho-write');
const config = require('../src/config');

async function main() {
  console.log('=== 完整流程验证（修复后）===\n');

  const ts = Date.now();
  const testTag = `VERIFY-${ts}`;

  // 初始化
  await sheet.readRows();
  console.log('[1] 元数据已加载\n');

  // 插入 3 张表各 3 行
  const sheets = [
    { id: 'q979lj', title: 'CS_Erik' },
    { id: '1vFP1N', title: 'CS_Echo' },
    { id: '77wr36', title: 'CS_Krystal' },
  ];

  console.log('[2] 插入测试数据（3 张表各 3 行）...\n');
  const allRecords = [];

  for (const s of sheets) {
    const records = [];
    for (let i = 1; i <= 3; i++) {
      records.push({
        fields: {
          '公证主体中文名': `${testTag}-${s.title}-公司${i}`,
          '第几单': `第${i}单`,
          '渠道名称': '深圳市瑞安信进出口有限公司',
          '订单金额': '1000',
          '订单日期': '2026-04-24',
          '订单导入者': 'IT',
          '订单所有者': 'zoho@inotary.com.hk',
        },
      });
    }

    const resp = await sheet.api('add_records', {
      docid: config.wecom.sheet.docid,
      sheet_id: s.id,
      records,
    });

    const recordIds = (resp.records || []).map(r => r.record_id);
    console.log(`✅ ${s.title} 插入 ${recordIds.length} 行`);
    allRecords.push(...records.map((r, idx) => ({
      sheet: s.title,
      subject: r.fields['公证主体中文名'] + r.fields['第几单'],
      recordId: recordIds[idx],
    })));
  }

  console.log(`\n共插入 ${allRecords.length} 行`);

  console.log('\n[3] 等待 15 秒让企微 API 生效...');
  await new Promise(r => setTimeout(r, 15000));

  console.log('\n[4] 手动触发同步...');
  await syncJob.runOnce();
  console.log('✅ 同步完成');

  console.log('\n[5] 查询 DB 里这些记录:');
  const dbResults = [];
  for (const item of allRecords) {
    // 用主题模糊查询（因为 business_key 可能为空）
    const rows = db.db.prepare(`
      SELECT s.row_id, s.file_no, s.zoho_id, s.status
      FROM sync_state s
      WHERE s.row_id LIKE ?
      ORDER BY s.updated_at DESC
      LIMIT 1
    `).all(`%${item.recordId}%`);

    if (rows.length > 0) {
      const row = rows[0];
      const parts = (row.file_no || '').split('/');
      const rand = parts[3] || '?';
      const flag = rand.length === 5 ? '✅' : (rand.length === 1 ? '❌' : '⚠️');
      console.log(`  ${flag} [${item.sheet}] ${item.subject}`);
      console.log(`      file_no=${row.file_no}  随机段="${rand}"`);
      dbResults.push({ ...item, ...row, rand });
    } else {
      console.log(`  ⚠️  [${item.sheet}] ${item.subject}  (DB 里没有)`);
    }
  }

  console.log('\n[6] 查询 ZOHO 验证是否被改:');
  let matched = 0, mismatched = 0;

  for (const item of dbResults.filter(r => r.zoho_id)) {
    const r = await zohoFetch(`/${config.zoho.moduleApiName}/${item.zoho_id}?fields=id,Name,field73,Modified_By`);
    const rec = r.data && r.data[0];
    if (rec) {
      const zohoParts = (rec.field73 || '').split('/');
      const zohoRand = zohoParts[3] || '?';
      const match = zohoRand === item.rand;
      const flag = match ? '✅' : '❌';

      console.log(`\n  ${flag} [${item.sheet}] Name=${rec.Name}`);
      console.log(`      DB:   ${item.file_no}  随机段="${item.rand}"`);
      console.log(`      ZOHO: ${rec.field73}  随机段="${zohoRand}"`);
      console.log(`      Modified_By: ${rec.Modified_By?.name}`);

      if (match) {
        matched++;
      } else {
        mismatched++;
        console.log(`      ^^^ 不匹配！ZOHO workflow 还在改`);
      }
    }
  }

  console.log('\n[7] 最终结果:');
  console.log(`  总计: ${matched + mismatched} 条`);
  console.log(`  ✅ 匹配: ${matched} 条`);
  console.log(`  ❌ 不匹配: ${mismatched} 条`);

  if (mismatched > 0) {
    console.log('\n🚨 ZOHO workflow 还有问题！');
    process.exit(1);
  } else {
    console.log('\n🎉 ZOHO workflow 修复成功！所有记录的 field73 都保持了我们生成的值');
    process.exit(0);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
