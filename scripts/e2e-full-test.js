// 全流程测试：插入多表多行 → 触发同步 → 检查 ZOHO 结果（不删除）
const config = require('../src/config');
const db = require('../src/utils/db');
const syncJob = require('../src/jobs/sync-job');

async function main() {
  console.log('=== 全流程测试：多表批量插入 + 同步 ===\n');

  const API_BASE = "https://qyapi.weixin.qq.com";
  let _token = null, _exp = 0;
  async function getToken() {
    if (_token && Date.now() < _exp) return _token;
    const url = `${API_BASE}/cgi-bin/gettoken?corpid=${config.wecom.corpId}&corpsecret=${config.wecom.agentSecret}`;
    const j = await (await fetch(url)).json();
    if (j.errcode !== 0) throw new Error(`获取 access_token 失败: ${j.errmsg}`);
    _token = j.access_token;
    _exp = Date.now() + (j.expires_in - 300) * 1000;
    return _token;
  }

  async function apiCall(path, body) {
    const token = await getToken();
    const r = await fetch(
      `${API_BASE}/cgi-bin/wedoc/smartsheet/${path}?access_token=${token}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );
    return r.json();
  }

  // 选 3 张表，每张插 5 行
  const sheets = [
    { id: 'q979lj', title: 'CS_Erik' },
    { id: '1vFP1N', title: 'CS_Echo' },
    { id: '77wr36', title: 'CS_Krystal' },
  ];

  const ts = Date.now();
  const allInserted = [];

  console.log('[1] 插入测试数据到 3 张表（每张 5 行）\n');

  for (const sheet of sheets) {
    const rows = [];
    for (let i = 1; i <= 5; i++) {
      rows.push({
        '主题': `全流程测试-${sheet.title}-${i}`,
        '渠道名称': '深圳市瑞安信进出口有限公司',  // 客户编号 10073
        '订单确认编号': `E2E-${ts}-${sheet.title}-${i}`,
        '订单金额': '1000',
        '订单日期': '2026-04-24',
        '订单导入者': 'IT',
        '订单所有者': 'zoho@inotary.com.hk',
      });
    }

    const records = rows.map(r => ({ fields: r }));
    const resp = await apiCall('add_records', {
      docid: config.wecom.sheet.docid,
      sheet_id: sheet.id,
      records,
    });

    if (resp.errcode !== 0) {
      console.log(`❌ ${sheet.title} 插入失败:`, JSON.stringify(resp));
      continue;
    }

    const recordIds = resp.records || [];
    console.log(`✅ ${sheet.title} 插入成功 ${recordIds.length} 行`);
    allInserted.push(...rows.map((r, idx) => ({
      sheet: sheet.title,
      businessKey: r['订单确认编号'],
      recordId: recordIds[idx]?.record_id,
    })));
  }

  console.log(`\n共插入 ${allInserted.length} 行到 ${sheets.length} 张表`);

  console.log('\n[2] 等待 5 秒让企微 API 生效...');
  await new Promise(r => setTimeout(r, 5000));

  console.log('\n[3] 手动触发 runOnce 同步...');
  const startTime = Date.now();
  await syncJob.runOnce();
  const elapsed = Date.now() - startTime;
  console.log(`✅ 同步完成，耗时 ${(elapsed/1000).toFixed(1)}s`);

  console.log('\n[4] 查询 DB 里这些记录的 file_no:\n');
  const dbResults = [];
  for (const item of allInserted) {
    const row = db.db.prepare('SELECT file_no, zoho_id, status FROM sync_state WHERE business_key = ?').get(item.businessKey);
    if (row) {
      const parts = (row.file_no || '').split('/');
      const rand = parts[3] || '?';
      const flag = rand.length === 5 ? '✅' : (rand.length === 1 ? '❌' : '⚠️');
      console.log(`  ${flag} [${item.sheet}] ${item.businessKey}`);
      console.log(`      file_no=${row.file_no}  随机段="${rand}"  status=${row.status}`);
      dbResults.push({ ...item, ...row, rand });
    } else {
      console.log(`  ⚠️  [${item.sheet}] ${item.businessKey}  (DB 里没有)`);
    }
  }

  console.log('\n[5] 查询 ZOHO 里这些记录的 field73:\n');
  const { zohoFetch } = require('../src/services/zoho-write');
  const zohoResults = [];

  for (const item of dbResults.filter(r => r.zoho_id)) {
    try {
      const r = await zohoFetch(`/${config.zoho.moduleApiName}/${item.zoho_id}?fields=id,Name,field73,Created_Time`);
      const rec = r.data && r.data[0];
      if (rec) {
        const parts = (rec.field73 || '').split('/');
        const zohoRand = parts[3] || '?';
        const match = zohoRand === item.rand;
        const flag = match ? '✅' : '❌';
        console.log(`  ${flag} [${item.sheet}] zoho_id=${item.zoho_id}`);
        console.log(`      DB  file_no=${item.file_no}  随机段="${item.rand}"`);
        console.log(`      ZOHO field73=${rec.field73}  随机段="${zohoRand}"`);
        if (!match) {
          console.log(`      ^^^ 不匹配！DB 是 "${item.rand}"，ZOHO 变成了 "${zohoRand}"`);
        }
        zohoResults.push({ ...item, zohoField73: rec.field73, zohoRand, match });
      }
    } catch (e) {
      console.log(`  ⚠️  [${item.sheet}] zoho_id=${item.zoho_id}  查询失败: ${e.message.slice(0,80)}`);
    }
  }

  console.log('\n[6] 汇总结果:\n');
  const total = zohoResults.length;
  const matched = zohoResults.filter(r => r.match).length;
  const mismatched = zohoResults.filter(r => !r.match).length;

  console.log(`  总计: ${total} 条`);
  console.log(`  ✅ 匹配: ${matched} 条（DB 和 ZOHO 的 file_no 一致）`);
  console.log(`  ❌ 不匹配: ${mismatched} 条（ZOHO 端被改了）`);

  if (mismatched > 0) {
    console.log(`\n🚨 发现 ${mismatched} 条异常！详情:`);
    zohoResults.filter(r => !r.match).forEach(r => {
      console.log(`  - [${r.sheet}] ${r.businessKey}`);
      console.log(`    DB: ${r.file_no}`);
      console.log(`    ZOHO: ${r.zohoField73}`);
      console.log(`    zoho_id: ${r.zoho_id}`);
    });

    console.log('\n查看日志里的生成记录:');
    console.log('  grep "生成文件编号" /tmp/wecom-sync.log | tail -20');
    console.log('  grep "\\[randomSegment\\]" /tmp/wecom-sync.log | tail -20');
  } else {
    console.log('\n✅ 全部匹配，没有发现异常');
  }

  console.log('\n[7] 测试数据已保留，不删除');
  console.log('    企微表里的 record_ids:', allInserted.map(i => i.recordId).join(', '));
  console.log('    ZOHO zoho_ids:', dbResults.filter(r => r.zoho_id).map(r => r.zoho_id).join(', '));
  console.log('    DB business_keys:', allInserted.map(i => i.businessKey).join(', '));

  console.log('\n✅ 测试完成');
  process.exit(mismatched > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
