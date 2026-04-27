// 用正确的格式插入记录（field_id + type/text 格式）
const config = require('../src/config');
const sheet = require('../src/services/wecom-sheet');

async function main() {
  console.log('=== 用正确格式插入测试数据 ===\n');

  // 先初始化 meta，拿到 field_id 映射
  await sheet.readRows();  // 触发 initMeta
  console.log('[1] 元数据已加载\n');

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

  // 获取 CS_Erik 的 field 映射
  const sheetId = 'q979lj';  // CS_Erik
  const metaResp = await apiCall('get_sheet_meta', {
    docid: config.wecom.sheet.docid,
    sheet_id: sheetId,
  });

  const fields = metaResp.properties?.sheet_views?.[0]?.property?.fields || [];
  const fieldMap = {};
  fields.forEach(f => {
    fieldMap[f.field_title] = f.field_id;
  });

  console.log('[2] CS_Erik 字段映射:');
  console.log('  主题 → ' + fieldMap['主题']);
  console.log('  渠道名称 → ' + fieldMap['渠道名称']);
  console.log('  订单确认编号 → ' + fieldMap['订单确认编号']);

  if (!fieldMap['主题'] || !fieldMap['渠道名称']) {
    console.log('❌ 缺少必要字段映射');
    process.exit(1);
  }

  console.log('\n[3] 插入 5 行测试数据...');
  const ts = Date.now();
  const records = [];
  for (let i = 1; i <= 5; i++) {
    const values = {};
    values[fieldMap['主题']] = [{ type: 'text', text: `正确格式测试${i}` }];
    values[fieldMap['渠道名称']] = [{ type: 'text', text: '深圳市瑞安信进出口有限公司' }];
    values[fieldMap['订单确认编号']] = [{ type: 'text', text: `CORRECT-${ts}-${i}` }];
    values[fieldMap['订单金额']] = [{ type: 'text', text: '1000' }];
    values[fieldMap['订单日期']] = [{ type: 'text', text: '2026-04-24' }];
    values[fieldMap['订单导入者']] = [{ type: 'text', text: 'IT' }];
    values[fieldMap['订单所有者']] = [{ type: 'text', text: 'zoho@inotary.com.hk' }];
    records.push({ values });
  }

  const resp = await apiCall('add_records', {
    docid: config.wecom.sheet.docid,
    sheet_id: sheetId,
    key_type: 'CELL_VALUE_KEY_TYPE_FIELD_ID',
    records,
  });

  if (resp.errcode !== 0) {
    console.log('❌ 插入失败:', JSON.stringify(resp));
    process.exit(1);
  }

  const recordIds = resp.records || [];
  console.log(`✅ 插入成功 ${recordIds.length} 行`);
  console.log('   record_ids:', recordIds.map(r => r.record_id).join(', '));

  console.log('\n[4] 等待 3 秒后读取验证...');
  await new Promise(r => setTimeout(r, 3000));

  const rows = await sheet.readRows();
  const testRows = rows.filter(r => r.data['主题'] && r.data['主题'].includes('正确格式测试'));
  console.log(`\n[5] readRows 找到 ${testRows.length} 条"正确格式测试"记录`);
  if (testRows.length > 0) {
    testRows.forEach(r => {
      console.log(`  ✅ ${r.data['主题']} - ${r.data['订单确认编号']}`);
    });
  } else {
    console.log('  ❌ 还是读不到，可能需要更长延迟或格式还是不对');
  }

  console.log('\n✅ 测试完成，记录已保留');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
