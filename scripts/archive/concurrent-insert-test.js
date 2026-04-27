// 通过企微 API 批量插入 10 行测试数据，触发真实同步
const sheet = require('../src/services/wecom-sheet');
const db = require('../src/utils/db');

async function main() {
  console.log('=== 批量插入 10 行测试数据到企微表 ===\n');

  // 选一张启用的子表（CS_Erik）
  const sheetId = 'q979lj';  // CS_Erik
  const sheetTitle = 'CS_Erik';

  const rows = [];
  for (let i = 1; i <= 10; i++) {
    rows.push({
      '主题': `并发测试${i}-${Date.now()}`,
      '渠道名称': '深圳市瑞安信进出口有限公司',  // 客户编号 10073
      '订单确认编号': `CONCURRENT-TEST-${Date.now()}-${i}`,
      '订单金额': '1000',
      '订单日期': '2026-04-24',
      '订单导入者': 'IT',
      '订单所有者': 'zoho@inotary.com.hk',
    });
  }

  console.log('[1] 准备插入 10 行到 CS_Erik');
  console.log('    渠道名称: 深圳市瑞安信进出口有限公司 (客户编号=10073)');
  console.log('    主题: 并发测试1~10');

  // 企微 API 批量插入
  const config = require('../src/config');

  // 直接调用企微 API（复用 wecom-sheet 的 token 逻辑）
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

  const records = rows.map(r => ({ fields: r }));

  console.log('\n[2] 调用企微 API 批量插入...');
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
  console.log('    record_ids:', recordIds.map(r => r.record_id).join(', '));

  console.log('\n[3] 等待 webhook 触发 + cron tick 同步（最多 90s）...');
  console.log('    观察 /tmp/wecom-sync.log 里的 [randomSegment] 和 📄 生成文件编号 日志');

  // 等待同步完成
  await new Promise(r => setTimeout(r, 90000));

  console.log('\n[4] 查询 DB 里这 10 条的 file_no:');
  const businessKeys = rows.map(r => r['订单确认编号']);
  for (const bk of businessKeys) {
    const row = db.db.prepare('SELECT file_no, zoho_id, status FROM sync_state WHERE business_key = ?').get(bk);
    if (row) {
      console.log(`  ${bk}  file_no=${row.file_no}  status=${row.status}`);
    } else {
      console.log(`  ${bk}  (DB 里还没有)`);
    }
  }

  console.log('\n[5] 查询 ZOHO 里这 10 条的 field73:');
  const zohoIds = [];
  for (const bk of businessKeys) {
    const row = db.db.prepare('SELECT zoho_id FROM sync_state WHERE business_key = ?').get(bk);
    if (row && row.zoho_id) zohoIds.push(row.zoho_id);
  }

  if (zohoIds.length > 0) {
    const { zohoFetch } = require('../src/services/zoho-write');
    const config = require('../src/config');
    for (const id of zohoIds) {
      const r = await zohoFetch(`/${config.zoho.moduleApiName}/${id}?fields=id,Name,field73`);
      const rec = r.data && r.data[0];
      if (rec) {
        const parts = (rec.field73 || '').split('/');
        const rand = parts[3] || '?';
        const flag = rand.length === 5 ? '✅' : '❌';
        console.log(`  ${flag} zoho_id=${id}  field73=${rec.field73}  随机段=${rand}`);
      }
    }
  } else {
    console.log('  (还没同步到 ZOHO)');
  }

  console.log('\n[6] 清理测试数据');
  // 删除企微表里的记录
  for (const rid of recordIds) {
    await apiCall('delete_records', {
      docid: config.wecom.sheet.docid,
      sheet_id: sheetId,
      record_ids: [rid.record_id],
    });
  }
  console.log(`已删除企微表里 ${recordIds.length} 行`);

  // 删除 ZOHO 里的记录
  if (zohoIds.length > 0) {
    const { zohoFetch } = require('../src/services/zoho-write');
    const config = require('../src/config');
    await zohoFetch(`/${config.zoho.moduleApiName}?ids=${zohoIds.join(',')}`, { method: 'DELETE' });
    console.log(`已删除 ZOHO 里 ${zohoIds.length} 条`);
  }

  // 删除 DB 记录
  for (const bk of businessKeys) {
    db.db.prepare('DELETE FROM sync_state WHERE business_key = ?').run(bk);
  }
  console.log(`已删除 DB 里 ${businessKeys.length} 条`);

  console.log('\n✅ 测试完成，请查看上面的输出和日志');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
