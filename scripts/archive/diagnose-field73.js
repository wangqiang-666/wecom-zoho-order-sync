// 查 ZOHO 端 field73 的字段配置 + 自动化规则
const { zohoFetch } = require('../src/services/zoho-write');
const config = require('../src/config');

async function main() {
  console.log('=== 1. 查 field73 字段元数据 ===');
  try {
    const fields = await zohoFetch(`/settings/fields?module=${config.zoho.moduleApiName}`);
    const f73 = (fields.fields || []).find(f => f.api_name === 'field73');
    if (f73) {
      console.log('field73 配置:');
      console.log('  data_type:', f73.data_type);
      console.log('  field_label:', f73.field_label);
      console.log('  read_only:', f73.read_only);
      console.log('  formula:', f73.formula ? JSON.stringify(f73.formula) : '(无)');
      console.log('  auto_number:', f73.auto_number ? JSON.stringify(f73.auto_number) : '(无)');
      console.log('  json_type:', f73.json_type);
      console.log('  全部属性:', JSON.stringify(f73, null, 2));
    } else {
      console.log('❌ 找不到 field73');
    }
  } catch (e) {
    console.log('查字段失败:', e.message);
  }

  console.log('\n=== 2. 查 workflow rules ===');
  try {
    const wf = await zohoFetch(`/settings/workflow_rules?module=${config.zoho.moduleApiName}`);
    const rules = wf.workflow_rules || [];
    console.log(`找到 ${rules.length} 条 workflow`);
    for (const r of rules) {
      // 看 actions 里有没有 update field73
      const actions = r.actions || [];
      const touchesF73 = actions.some(a =>
        JSON.stringify(a).includes('field73') ||
        (a.field_updates && a.field_updates.some(u => u.api_name === 'field73'))
      );
      if (touchesF73 || r.name.toLowerCase().includes('field') || r.name.toLowerCase().includes('file')) {
        console.log(`\n  [${r.id}] ${r.name}`);
        console.log(`    状态: ${r.state}  触发: ${r.trigger}`);
        console.log(`    条件: ${JSON.stringify(r.criteria || {}).slice(0, 200)}`);
        console.log(`    动作: ${JSON.stringify(actions).slice(0, 300)}`);
      }
    }
  } catch (e) {
    console.log('查 workflow 失败:', e.message);
  }

  console.log('\n=== 3. 查 blueprint ===');
  try {
    const bp = await zohoFetch(`/settings/blueprints?module=${config.zoho.moduleApiName}`);
    const blueprints = bp.blueprints || [];
    console.log(`找到 ${blueprints.length} 条 blueprint`);
    for (const b of blueprints) {
      console.log(`  [${b.id}] ${b.blueprint_label} (状态=${b.status})`);
      // transitions 里可能有 field_updates
      const transitions = b.transitions || [];
      for (const t of transitions) {
        const updates = t.field_updates || [];
        const hasF73 = updates.some(u => u.api_name === 'field73');
        if (hasF73) {
          console.log(`    转换「${t.name}」会更新 field73:`, JSON.stringify(updates.find(u => u.api_name === 'field73')));
        }
      }
    }
  } catch (e) {
    console.log('查 blueprint 失败:', e.message);
  }

  console.log('\n=== 4. 查最近一条异常记录的 timeline ===');
  try {
    // 拿刚才那条 IN/NP/10073/1/2026 的 id=216300000094171691
    const id = '216300000094171691';
    const timeline = await zohoFetch(`/${config.zoho.moduleApiName}/${id}/__timeline`);
    const events = timeline.__timeline || [];
    console.log(`记录 ${id} 有 ${events.length} 条 timeline 事件`);
    for (const e of events) {
      const str = JSON.stringify(e);
      if (str.includes('field73') || str.includes('文件编号') || e.type === 'field_history') {
        console.log(`  [${e.created_time}] ${e.type} by ${e.done_by?.name}`);
        console.log(`    ${str.slice(0, 500)}`);
      }
    }
  } catch (e) {
    console.log('查 timeline 失败:', e.message);
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
