// 实时监控 ZOHO 最近记录的 field73，发现异常立刻报警
const { zohoFetch } = require('../src/services/zoho-write');
const config = require('../src/config');
const db = require('../src/utils/db');
const fs = require('fs');

async function check() {
  try {
    // 拉最近 20 条记录
    const data = await zohoFetch(`/${config.zoho.moduleApiName}?fields=id,Name,field73,Created_Time&sort_order=desc&sort_by=Created_Time&per_page=20`);
    const rows = data.data || [];

    for (const r of rows) {
      const f73 = r.field73 || '';
      const parts = f73.split('/');
      if (parts.length === 5 && parts[3] && parts[3].length === 1) {
        // 发现异常！
        console.log(`\n🚨🚨🚨 发现异常 field73！🚨🚨🚨`);
        console.log(`zoho_id=${r.id}`);
        console.log(`Name=${r.Name}`);
        console.log(`field73=${f73}  ← 随机段只有 1 位："${parts[3]}"`);
        console.log(`Created_Time=${r.Created_Time}`);

        // 查 DB
        const dbRow = db.db.prepare('SELECT * FROM sync_state WHERE zoho_id = ?').get(r.id);
        if (dbRow) {
          console.log(`\nDB 里的 file_no: ${dbRow.file_no}`);
          console.log(`DB 完整记录: ${JSON.stringify(dbRow, null, 2)}`);
        } else {
          console.log(`\nDB 里没有这条记录`);
        }

        // 查日志（根据创建时间前后 1 分钟）
        const ct = new Date(r.Created_Time);
        const logTime = ct.toISOString().slice(0, 16).replace('T', ' ');  // 2026-04-24 09:19
        console.log(`\n查日志（时间=${logTime}）:`);
        const { execSync } = require('child_process');
        try {
          const logs = execSync(`grep "${logTime}" /tmp/wecom-sync.log | grep -E "生成文件编号|randomSegment.*${parts[3]}" | head -20`, { encoding: 'utf8' });
          console.log(logs || '(没找到相关日志)');
        } catch (e) {
          console.log('(grep 没匹配到)');
        }

        // 写报告
        const report = `
=== 异常 field73 报告 ===
时间: ${new Date().toISOString()}
zoho_id: ${r.id}
Name: ${r.Name}
field73: ${f73}
随机段: "${parts[3]}" (长度=${parts[3].length})
Created_Time: ${r.Created_Time}

DB file_no: ${dbRow ? dbRow.file_no : 'N/A'}
DB 记录: ${dbRow ? JSON.stringify(dbRow, null, 2) : 'N/A'}

日志时间: ${logTime}
`;
        fs.appendFileSync('/tmp/field73-anomaly-report.txt', report);
        console.log(`\n报告已追加到 /tmp/field73-anomaly-report.txt`);

        // 只报第一条，避免刷屏
        return true;
      }
    }
    return false;
  } catch (e) {
    console.error('监控出错:', e.message);
    return false;
  }
}

async function monitor() {
  console.log('开始监控 ZOHO field73 异常（每 30 秒检查一次）...');
  console.log('按 Ctrl+C 停止\n');

  while (true) {
    const found = await check();
    if (found) {
      console.log('\n已发现异常，继续监控...\n');
    } else {
      process.stdout.write('.');
    }
    await new Promise(r => setTimeout(r, 30000));
  }
}

// 如果直接运行，启动监控；如果被 require，导出 check 函数
if (require.main === module) {
  monitor().catch(e => { console.error(e); process.exit(1); });
} else {
  module.exports = { check };
}
