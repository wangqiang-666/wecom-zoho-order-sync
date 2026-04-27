// 实时抓现行：POST 一条测试记录 → 立刻 GET → 对比 field73
const { zohoFetch } = require('../src/services/zoho-write');
const config = require('../src/config');
const fileNo = require('../src/utils/file-no');

async function main() {
  console.log('=== 创建测试订单，观察 field73 是否被 ZOHO 端改动 ===\n');

  // 1. 生成一个文件编号
  const testFileNo = `IN/NP/99999/TEST${Date.now().toString().slice(-4)}/2026`;
  console.log(`[1] 本地生成 file_no = ${testFileNo}`);

  // 2. POST 到 ZOHO（只带核心字段，避免类型错误）
  const payload = {
    Name: `field73诊断-${Date.now()}`,
    field73: testFileNo,
    field235: `DIAG-${Date.now()}`,
  };
  console.log(`[2] POST payload.field73 = ${payload.field73}`);

  const postResp = await zohoFetch(`/${config.zoho.moduleApiName}`, {
    method: 'POST',
    body: JSON.stringify({ data: [payload], trigger: ['workflow'] }),
  });
  const row = postResp.data?.[0];
  if (row.code !== 'SUCCESS') {
    console.log('❌ POST 失败:', JSON.stringify(row));
    process.exit(1);
  }
  const zohoId = row.details.id;
  console.log(`[3] POST 成功，zoho_id = ${zohoId}`);
  console.log(`    ZOHO 返回的 details:`, JSON.stringify(row.details).slice(0, 300));

  // 3. 立刻 GET 回来看 field73
  await new Promise(r => setTimeout(r, 2000));  // 等 2s 让 workflow 跑完
  const getResp = await zohoFetch(`/${config.zoho.moduleApiName}/${zohoId}?fields=id,Name,field73,field235,Modified_Time,Modified_By`);
  const rec = getResp.data?.[0];
  console.log(`\n[4] GET 回来的 field73 = ${rec.field73}`);
  console.log(`    Modified_By = ${rec.Modified_By?.name}  Modified_Time = ${rec.Modified_Time}`);

  // 4. 对比
  if (rec.field73 === testFileNo) {
    console.log('\n✅ field73 没被改，ZOHO 端保持原值');
  } else {
    console.log(`\n❌ field73 被改了！`);
    console.log(`   我们发的: ${testFileNo}`);
    console.log(`   ZOHO 变成: ${rec.field73}`);
    console.log(`   改动者: ${rec.Modified_By?.name}`);
    console.log(`\n🔍 这证明 ZOHO 端有 workflow / blueprint / 字段规则在覆盖 field73`);
  }

  // 5. 清理测试记录
  console.log(`\n[5] 删除测试记录 ${zohoId}`);
  await zohoFetch(`/${config.zoho.moduleApiName}?ids=${zohoId}`, { method: 'DELETE' });
  console.log('已清理');

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
