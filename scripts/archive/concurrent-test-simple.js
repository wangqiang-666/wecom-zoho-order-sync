// 简化版：插入 10 行 → 手动触发同步 → 检查结果
const config = require('../src/config');
const db = require('../src/utils/db');
const syncJob = require('../src/jobs/sync-job');

async function main() {
  console.log('=== 批量插入 10 行 + 手动触发同步 ===\n');

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

  const sheetId = 'q979lj';  // CS_Erik
  const rows = [];
  const ts = Date.now();
  for (let i = 1; i <= 10; i++) {
    rows.push({
      '主题': `并发测试${i}-${ts}`,
      '渠道名称': '深圳市瑞安信进出口有限公司',
      '订单确认编号': `CONCURRENT-${ts}-${i}`,
      '订单金额': '1000',
      '订单日期': '2026-04-24',
      '订单导入者': 'IT',
      '订单所有者': 'zoho@inotary.com.hk',
    });
  }

  console.log('[1] 插入 10 行到 CS_Erik (渠道=深圳市瑞安信，客户编号=10073)');
  const records = rows.map(r => ({ fields: r }));
  const resp = await apiCall('add_records', {
    docid: config.wecom.sheet.docid,
    sheet_id: sheetId,
    records,
  });

  if (resp.errcode !== 0) {
    console.log('❌ 插入失败:', JSON.stringify(resp));
    process.exit(1);
  }

  const recordIds = resp.records || [];
  console.log(`✅ 插入成功 ${recordIds.length} 行`);

  console.log('\n[2] 手动触发 runOnce 同步...');
  await syncJob.runOnce();
  console.log('✅ 同步完成');

  console.log('\n[3] 查询 DB 里这 10 条的 file_no:');
  const businessKeys = rows.map(r => r['订单确认编号']);
  const dbRows = [];
  for (const bk of businessKeys) {
    const row = db.db.prepare('SELECT file_no, zoho_id, status FROM sync_state WHERE business_key = ?').get(bk);
    if (row) {
      const parts = (row.file_no || '').split('/');
      const rand = parts[3] || '?';
      const flag = rand.length === 5 ? '✅' : (rand.length === 1 ? '❌' : '⚠️');
      console.log(`  ${flag} ${bk}  file_no=${row.file_no}  随机段=${rand}  status=${row.status}`);
      dbRows.push(row);
    } else {
      console.log(`  ⚠️  ${bk}  (DB 里没有)`);
    }
  }

  console.log('\n[4] 查询 ZOHO 里这 10 条的 field73:');
  const zohoIds = dbRows.filter(r => r.zoho_id).map(r => r.zoho_id);
  if (zohoIds.length > 0) {
    const { zohoFetch } = require('../src/services/zoho-write');
    for (const id of zohoIds) {
      const r = await zohoFetch(`/${config.zoho.moduleApiName}/${id}?fields=id,Name,field73`);
      const rec = r.data && r.data[0];
      if (rec) {
        const parts = (rec.field73 || '').split('/');
        const rand = parts[3] || '?';
        const flag = rand.length === 5 ? '✅' : (rand.length === 1 ? '❌' : '⚠️');
        console.log(`  ${flag} zoho_id=${id}  field73=${rec.field73}  随机段=${rand}`);
      }
    }
  } else {
    console.log('  (没有 zoho_id)');
  }

  console.log('\n[5] 清理测试数据');
  for (const rid of recordIds) {
    await apiCall('delete_records', {
      docid: config.wecom.sheet.docid,
      sheet_id: sheetId,
      record_ids: [rid.record_id],
    });
  }
  console.log(`已删除企微表里 ${recordIds.length} 行`);

  if (zohoIds.length > 0) {
    const { zohoFetch } = require('../src/services/zoho-write');
    await zohoFetch(`/${config.zoho.moduleApiName}?ids=${zohoIds.join(',')}`, { method: 'DELETE' });
    console.log(`已删除 ZOHO 里 ${zohoIds.length} 条`);
  }

  for (const bk of businessKeys) {
    db.db.prepare('DELETE FROM sync_state WHERE business_key = ?').run(bk);
  }
  console.log(`已删除 DB 里 ${businessKeys.length} 条`);

  console.log('\n✅ 测试完成');
  console.log('\n请查看 /tmp/wecom-sync.log 里的 [randomSegment] 日志，看原始字节');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
