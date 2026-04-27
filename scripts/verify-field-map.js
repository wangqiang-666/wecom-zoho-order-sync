/**
 * 字段映射一致性校验：
 *   1. 拉取企微 CS_Erik 子表的真实字段
 *   2. 和 field-map.json 中配置的 source 对比
 *   3. 输出缺失/多余/类型潜在冲突，方便人工核对
 *
 * 运行：node scripts/verify-field-map.js
 */
require("dotenv").config();
const config = require("../src/config");

const DOCID = config.wecom.sheet.docid;
const TARGET_SHEET = "CS_Erik";

async function getToken() {
  const r = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${config.wecom.corpId}&corpsecret=${config.wecom.agentSecret}`
  );
  return (await r.json()).access_token;
}

async function post(path, token, body) {
  const r = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/wedoc/smartsheet/${path}?access_token=${token}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
  return r.json();
}

(async () => {
  const token = await getToken();
  const sheets = await post("get_sheet", token, { docid: DOCID, need_all_type_sheet: true });
  const target = sheets.sheet_list.find((s) => s.title === TARGET_SHEET);
  const fields = await post("get_fields", token, {
    docid: DOCID, sheet_id: target.sheet_id, offset: 0, limit: 1000,
  });

  const remote = fields.fields; // [{field_id, field_title, field_type}, ...]
  const remoteNames = new Set(remote.map((f) => f.field_title));
  const remoteByTitle = Object.fromEntries(remote.map((f) => [f.field_title, f]));

  const mapped = config.fieldMap.fields;
  const mappedSources = new Set(mapped.map((m) => m.source));

  // 简化的 企微字段类型 → 期望 field-map type
  const COMPAT = {
    FIELD_TYPE_TEXT:          ["text", "textarea", "local", "integer", "double"],
    FIELD_TYPE_NUMBER:        ["integer", "double"],
    FIELD_TYPE_DATE_TIME:     ["date"],
    FIELD_TYPE_SINGLE_SELECT: ["picklist"],
    FIELD_TYPE_MULTI_SELECT:  ["multiselectpicklist"],
    FIELD_TYPE_REFERENCE:     ["text", "lookup"], // 企微 Reference 本质是子表联动，常以 text/lookup 配
    FIELD_TYPE_FORMULA:       ["text", "local"],  // 公式列，对我们是只读；主题字段就是这个
    FIELD_TYPE_CHECKBOX:      ["boolean"],
  };

  console.log(`\n📋 企微 ${TARGET_SHEET} 共 ${remote.length} 个字段 vs field-map.json ${mapped.length} 条映射\n`);
  console.log("=".repeat(90));

  // 1. 映射表中的每一条，看企微端是否有对应字段
  console.log("\n【映射表 → 企微】\n");
  let missingInRemote = 0, typeMismatch = 0;
  for (const m of mapped) {
    const r = remoteByTitle[m.source];
    if (!r) {
      console.log(`❌ 缺失  ${m.source.padEnd(20)} → 企微中找不到此列`);
      missingInRemote++;
      continue;
    }
    const compat = COMPAT[r.field_type] || [];
    const ok = compat.includes(m.type);
    const flag = ok ? "✅" : "⚠️ ";
    const extra = ok ? "" : `（企微=${r.field_type}，map=${m.type}，可能需复核）`;
    console.log(`${flag} ${m.source.padEnd(20)} [field_id=${r.field_id}]  ${r.field_type.padEnd(24)} → ${m.type}${extra ? "  " + extra : ""}`);
    if (!ok) typeMismatch++;
  }

  // 2. 企微端有，但映射表没配的
  console.log("\n【企微 → 映射表】\n");
  let extraInRemote = 0;
  for (const r of remote) {
    if (!mappedSources.has(r.field_title)) {
      console.log(`➖ 未映射  ${r.field_title.padEnd(20)} [${r.field_type}]  （如需同步请加到 field-map.json）`);
      extraInRemote++;
    }
  }

  console.log("\n" + "=".repeat(90));
  console.log(`汇总：  映射条数=${mapped.length}   企微字段=${remote.length}`);
  console.log(`         缺失(映射有但企微无)=${missingInRemote}  `);
  console.log(`         未映射(企微有但未配)=${extraInRemote}  `);
  console.log(`         类型可能冲突=${typeMismatch}`);
})().catch(console.error);
