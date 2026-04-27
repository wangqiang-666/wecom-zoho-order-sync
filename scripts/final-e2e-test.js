// 最简化：用 wecom-sheet.api 插入 → 手动同步 → 检查结果
const sheet = require('../src/services/wecom-sheet');
const syncJob = require('../src/jobs/sync-job');
const db = require('../src/utils/db');
const config = require('../src/config');

async function main() {
  console.log('=== 多表批量测试（修复后验证）===\n');
  const ts = Date.now();

  // 初始化 meta
  await sheet.readRows();
  console.log('[1] 元数据已加载\n');

  // 插入 3 张表，每张 5 行
  const sheets = [
    { id: 'q979lj', title: 'CS_Erik' },
    { id: '1vFP1N', title: 'CS_Echo' },
    { id: '77wr36', title: 'CS_Krystal' },
  ];

  console.log('[2] 插入测试数据到 3 张表（每张 5 行）...');
  const allRecords = [];

  for (const s of sheets) {
    const records = [];
    for (let i = 1; i <= 5; i++) {
      records.push({
        fields: {
          '公证主体中文名': `${s.title}测试${i}`,
          '第几单': `第${i}单`,
          '渠道名称': '深圳市瑞安信进出口有限公司',
          '订单确认编号': `MULTI-${ts}-${s.title}-${i}`,
          '订单金额': '1000',
          '订单日期': '2026-04-24',
          '业务员': 'IT',
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
    console.log(`✅ ${s.title} 插入成功 ${recordIds.length} 行`);
    allRecords.push(...records.map((r, idx) => ({
      sheet: s.title,
      businessKey: r.fields['订单确认编号'],
      recordId: recordIds[idx],
    })));
  }

  console.log(`\n共插入 ${allRecords.length} 行到 ${sheets.length} 张表`);

  console.log('\n[3] 等待 10 秒让企微 API 生效...');
  await new Promise(r => setTimeout(r, 10000));

  console.log('\n[4] 手动触发 runOnce 同步...');
  await syncJob.runOnce();
  console.log('✅ 同步完成');

  console.log('\n[5] 查询 DB 结果:');
  const businessKeys = allRecords.map(r => r.businessKey);
  const dbResults = [];
  for (const item of allRecords) {
    const row = db.db.prepare('SELECT file_no, zoho_id, status FROM sync_state WHERE business_key = ?').get(item.businessKey);
    if (row) {
      const parts = (row.file_no || '').split('/');
      const rand = parts[3] || '?';
      const flag = rand.length === 5 ? '✅' : (rand.length === 1 ? '❌' : '⚠️');
      console.log(`  ${flag} [${item.sheet}] ${item.businessKey}  file_no=${row.file_no}  随机段="${rand}"`);
      dbResults.push({ ...item, ...row, rand });
    } else {
      console.log(`  ⚠️  [${item.sheet}] ${item.businessKey}  (DB 里没有)`);
    }
  }

  console.log('\n[6] 查询 ZOHO 结果:');
  const { zohoFetch } = require('../src/services/zoho-write');
  const zohoResults = [];
  for (const item of dbResults.filter(r => r.zoho_id)) {
    const r = await zohoFetch(`/${config.zoho.moduleApiName}/${item.zoho_id}?fields=id,Name,field73`);
    const rec = r.data && r.data[0];
    if (rec) {
      const parts = (rec.field73 || '').split('/');
      const zohoRand = parts[3] || '?';
      const match = zohoRand === item.rand;
      const flag = match ? '✅' : '❌';
      console.log(`  ${flag} [${item.sheet}] ${item.businessKey}`);
      console.log(`      DB: ${item.file_no}  随机段="${item.rand}"`);
      console.log(`      ZOHO: ${rec.field73}  随机段="${zohoRand}"`);
      if (!match) {
        console.log(`      ^^^ 不匹配！ZOHO 被改了`);
      }
      zohoResults.push({ ...item, zohoField73: rec.field73, zohoRand, match });
    }
  }

  console.log('\n[7] 汇总结果:');
  const total = zohoResults.length;
  const matched = zohoResults.filter(r => r.match).length;
  const mismatched = zohoResults.filter(r => !r.match).length;
  console.log(`  总计: ${total} 条`);
  console.log(`  ✅ 匹配: ${matched} 条（DB 和 ZOHO 一致）`);
  console.log(`  ❌ 不匹配: ${mismatched} 条（ZOHO 被改了）`);

  if (mismatched > 0) {
    console.log('\n🚨 还有异常！ZOHO workflow 修复不完整');
    process.exit(1);
  } else {
    console.log('\n✅ 全部匹配，ZOHO workflow 修复成功！');
  }

  console.log('\n✅ 测试完成，数据已保留（不删除）');
  console.log('查看日志: grep "\\[randomSegment\\]" /tmp/wecom-sync.log | tail -20');
  process.exit(mismatched > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
