/**
 * 给 xlsx 的"文件编号"列填充 IN/NP/<客户编号>/<5位随机>/<年> 编号。
 *
 * 用法：
 *   node scripts/fill-file-no-xlsx.js <xlsx路径> <渠道客户名> [文件编号列名=文件编号]
 *
 * 例：
 *   node scripts/fill-file-no-xlsx.js ~/Desktop/海牙清单--48.xlsx "从零到一企业管理咨询(深圳)有限公司"
 *
 * 流程：
 *   1. ZOHO Accounts 按客户名查 field62 → 提客户编号（A12421→12421）
 *   2. 遍历 xlsx，跳过空行和已有编号的行
 *   3. 每行调 generateForCustomer 拿唯一编号（落 sync_state 查重）
 *   4. 备份原文件后写回
 */

const fs = require("fs");
const xlsx = require("node-xlsx");
const dbMod = require("../src/utils/db");
const { generateForCustomer } = require("../src/utils/file-no");
const { zohoFetch } = require("../src/services/zoho-write");

const xlsxPath = process.argv[2];
const customerName = process.argv[3];
const colName = process.argv[4] || "文件编号";

if (!xlsxPath || !customerName) {
  console.error("用法: node scripts/fill-file-no-xlsx.js <xlsx路径> <渠道客户名> [文件编号列名]");
  process.exit(1);
}

// 本地查重：查 sync_state.file_no 是否已有
const sessionUsed = new Set();
function isFileNoUsed(no) {
  if (sessionUsed.has(no)) return true;
  return !!dbMod.findFileNo(no);
}
function markUsed(no) {
  sessionUsed.add(no);
}

// 把本次生成的编号登记到 sync_state，防止下次再跑撞号
const insertStmt = dbMod.db.prepare(`
  INSERT INTO sync_state (row_id, status, attempts, file_no, created_at, updated_at)
  VALUES (?, 'pre_allocated', 0, ?, ?, ?)
`);

(async () => {
  const sheets = xlsx.parse(xlsxPath);
  const sheet = sheets[0];
  const rows = sheet.data;
  const header = rows[0];
  const colIdx = header.indexOf(colName);
  if (colIdx < 0) {
    console.error(`未找到列：${colName}，表头为：${JSON.stringify(header)}`);
    process.exit(1);
  }

  let filled = 0;
  let skipped = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row[1] || String(row[1]).trim() === "") continue;
    if (row[colIdx] && String(row[colIdx]).trim() !== "") {
      skipped++;
      continue;
    }
    while (row.length <= colIdx) row.push("");

    const { fileNo } = await generateForCustomer({
      customerName,
      zohoFetch,
      isFileNoUsed,
      markUsed,
    });
    row[colIdx] = fileNo;
    const now = Date.now();
    insertStmt.run(`xlsx:${xlsxPath}:${i}:${now}`, fileNo, now, now);
    filled++;
  }

  const backup = xlsxPath.replace(/\.xlsx$/i, `.bak-${Date.now()}.xlsx`);
  fs.copyFileSync(xlsxPath, backup);
  fs.writeFileSync(xlsxPath, xlsx.build([{ name: sheet.name, data: rows }]));

  console.log(`渠道客户：${customerName}`);
  console.log(`已填充 ${filled} 条编号，跳过已存在 ${skipped} 条`);
  console.log(`备份：${backup}`);
  console.log(`输出：${xlsxPath}`);
})().catch((e) => {
  console.error("失败：", e.message);
  process.exit(1);
});
