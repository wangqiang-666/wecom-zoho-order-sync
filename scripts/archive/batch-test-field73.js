// 批量 POST 10 条，模拟"同时执行 10 单"场景
const { zohoFetch } = require('../src/services/zoho-write');
const config = require('../src/config');

async function main() {
  console.log('=== 批量创建 10 条订单，观察 field73 ===\n');

  const batch = [];
  const expected = [];
  for (let i = 1; i <= 10; i++) {
    const fileNo = `IN/NP/10073/BATCH${i.toString().padStart(2,'0')}/2026`;
    expected.push({ idx: i, fileNo });
    batch.push({
      Name: `批量测试${i}`,
      field73: fileNo,
      field235: `BATCH-${Date.now()}-${i}`,
    });
  }

  console.log('[1] 准备 POST 10 条，field73 分别是:');
  expected.forEach(e => console.log(`    ${e.idx}. ${e.fileNo}`));

  const postResp = await zohoFetch(`/${config.zoho.moduleApiName}`, {
    method: 'POST',
    body: JSON.stringify({ data: batch, trigger: ['workflow'] }),
  });

  const rows = postResp.data || [];
  console.log(`\n[2] POST 返回 ${rows.length} 条结果`);
  const ids = rows.filter(r => r.code === 'SUCCESS').map(r => r.details.id);
  console.log(`    成功 ${ids.length} 条: ${ids.join(', ')}`);

  console.log('\n[3] 等 3s 让 workflow 跑完...');
  await new Promise(r => setTimeout(r, 3000));

  console.log('\n[4] GET 回来对比 field73:');
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const exp = expected[i];
    const getResp = await zohoFetch(`/${config.zoho.moduleApiName}/${id}?fields=id,Name,field73`);
    const rec = getResp.data?.[0];
    const match = rec.field73 === exp.fileNo;
    const flag = match ? '✅' : '❌';
    console.log(`  ${flag} [${i+1}] 期望=${exp.fileNo}  实际=${rec.field73}`);
    if (!match) {
      console.log(`       ^^^ 被改了！从 ${exp.fileNo} 变成 ${rec.field73}`);
    }
  }

  console.log('\n[5] 清理测试记录');
  if (ids.length > 0) {
    await zohoFetch(`/${config.zoho.moduleApiName}?ids=${ids.join(',')}`, { method: 'DELETE' });
    console.log(`已删除 ${ids.length} 条`);
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
