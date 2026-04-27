// 直接模拟 10 行并发调用 processOne，绕过企微表
const syncJob = require('../src/jobs/sync-job');
const db = require('../src/utils/db');
const { zohoFetch } = require('../src/services/zoho-write');

async function main() {
  console.log('=== 模拟 10 行并发生成 file_no ===\n');

  // 构造 10 行测试数据（模拟 readRows 返回的格式）
  const rows = [];
  const ts = Date.now();
  for (let i = 1; i <= 10; i++) {
    const rowId = `test::concurrent::${ts}-${i}`;
    const data = {
      '主题': `并发测试${i}`,
      '渠道名称': '深圳市瑞安信进出口有限公司',  // 客户编号 10073
      '订单确认编号': `CONCURRENT-${ts}-${i}`,
      '订单金额': '1000',
      '订单日期': '2026-04-24',
      '订单导入者': 'IT',
      '订单所有者': 'zoho@inotary.com.hk',
    };
    rows.push({
      rowId,
      recordId: rowId,
      sheetId: 'test',
      sheetTitle: 'TEST',
      rowIndex: i,
      status: null,
      data,
      hash: require('crypto').createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16),
    });
  }

  console.log('[1] 准备 10 行数据（渠道=深圳市瑞安信，客户编号=10073）');

  // 模拟 _runOnceInternal 的环境
  const customerCodeCache = new Map();
  const inflightFileNos = new Set();
  const requiredOverride = null;
  const lockedSources = new Set();
  const cooldownMs = 0;

  console.log('\n[2] 并发调用 generateForCustomer（手动实现 4 并发）...');

  const results = [];
  const batches = [];
  for (let i = 0; i < rows.length; i += 4) {
    batches.push(rows.slice(i, i + 4));
  }

  for (const batch of batches) {
    const tasks = batch.map(async (row) => {
      const fileNo = require('../src/utils/file-no');
      const customerName = String(row.data["渠道名称"] || "").trim();

      console.log(`  [行${row.rowIndex}] 开始生成 file_no...`);
      const gen = await fileNo.generateForCustomer({
        customerName,
        zohoFetch,
        isFileNoUsed: (no) => !!db.findFileNo(no) || inflightFileNos.has(no),
        markUsed: (no) => { inflightFileNos.add(no); },
        customerCodeCache,
      });

      const parts = gen.fileNo.split('/');
      const rand = parts[3] || '?';
      const flag = rand.length === 5 ? '✅' : (rand.length === 1 ? '❌' : '⚠️');
      console.log(`  ${flag} [行${row.rowIndex}] file_no=${gen.fileNo}  随机段=${rand}  客户编号=${gen.customerCode}`);

      return { row, fileNo: gen.fileNo, rand };
    });

    const batchResults = await Promise.all(tasks);
    results.push(...batchResults);
  }

  console.log('\n[3] 结果汇总:');
  const bad = results.filter(r => r.rand.length !== 5);
  if (bad.length > 0) {
    console.log(`❌ 发现 ${bad.length} 条异常:`);
    bad.forEach(r => console.log(`   行${r.row.rowIndex}: ${r.fileNo}  随机段="${r.rand}"`));
  } else {
    console.log(`✅ 全部 ${results.length} 条都是正常 5 位随机段`);
  }

  console.log('\n[4] 查看日志里的 [randomSegment] 输出:');
  console.log('    grep "[randomSegment]" /tmp/wecom-sync.log | tail -20');

  process.exit(bad.length > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
