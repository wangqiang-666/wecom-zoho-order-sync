/**
 * 诊断 CS_Echo 子表的字段
 */

require("dotenv").config();
const config = require("../src/config");

async function getToken() {
  const API_BASE = "https://qyapi.weixin.qq.com";
  const url = `${API_BASE}/cgi-bin/gettoken?corpid=${config.wecom.corpId}&corpsecret=${config.wecom.agentSecret}`;
  const j = await (await fetch(url)).json();
  if (j.errcode !== 0) throw new Error(`获取 token 失败: ${j.errmsg}`);
  return j.access_token;
}

async function api(path, body, token) {
  const API_BASE = "https://qyapi.weixin.qq.com";
  const r = await fetch(
    `${API_BASE}/cgi-bin/wedoc/smartsheet/${path}?access_token=${token}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
  const j = await r.json();
  if (j.errcode !== 0) {
    throw new Error(`企微 ${path} 调用失败 [${j.errcode}]: ${j.errmsg}`);
  }
  return j;
}

async function main() {
  const token = await getToken();
  const docid = config.wecom.sheet.docid;

  // 获取所有子表
  const doc = await api("get_sheet_list", { docid, offset: 0, limit: 100 }, token);
  const echoSheet = doc.sheet_list.find(s => s.title === "CS_Echo");

  if (!echoSheet) {
    console.log("未找到 CS_Echo 子表");
    return;
  }

  console.log("CS_Echo sheet_id:", echoSheet.sheet_id);

  // 获取字段
  const fields = await api("get_fields", { docid, sheet_id: echoSheet.sheet_id, offset: 0, limit: 1000 }, token);

  console.log("\n所有字段（共 %d 个）:", fields.fields.length);
  fields.fields.forEach((f, i) => {
    const bytes = Buffer.from(f.field_title, 'utf8');
    console.log("  %d. \"%s\" (bytes: %s, field_id: %s)",
      i+1,
      f.field_title,
      bytes.toString('hex'),
      f.field_id
    );
  });

  // 检查目标字段
  const target1 = "是否确定导入";
  const target2 = "导入状态";

  const field1 = fields.fields.find(f => f.field_title === target1);
  const field2 = fields.fields.find(f => f.field_title === target2);

  console.log("\n字段匹配结果:");
  console.log("  \"%s\": %s", target1, field1 ? `✓ 找到 (${field1.field_id})` : "✗ 未找到");
  console.log("  \"%s\": %s", target2, field2 ? `✓ 找到 (${field2.field_id})` : "✗ 未找到");

  if (!field1) {
    console.log("\n可能的匹配（模糊搜索）:");
    fields.fields.forEach(f => {
      if (f.field_title.includes("确认") || f.field_title.includes("导入")) {
        console.log("  - \"%s\"", f.field_title);
      }
    });
  }
}

main().catch(e => {
  console.error("错误:", e.message);
  process.exit(1);
});
