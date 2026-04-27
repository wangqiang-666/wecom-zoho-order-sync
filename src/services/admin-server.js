/**
 * 管理后台 + 健康检查（纯 Node http，无 Express 依赖）
 *
 * 路由：
 *   GET  /health                 存活探针
 *   GET  /api/status             当前配置 + 子表清单 + 最近一轮统计
 *   POST /api/sheets     body={names:"CS_Erik,CS_Alice"}   （空串=用 prefix 自动发现）
 *   POST /api/interval   body={sec:300}                    最小 30 秒
 *   POST /api/run-now                                      立即触发一次
 *   GET  /                       返回单页 HTML 配置界面
 *
 * 鉴权：无（内网使用）。如需外网要加反向代理或 token。
 */

const http = require("http");
const { URL } = require("url");
const config = require("../config");
const logger = require("../utils/logger");
const runtimeConfig = require("../utils/runtime-config");
const wecomSheet = require("../services/wecom-sheet");
const db = require("../utils/db").db;
const dbApi = require("../utils/db");
const syncJob = require("../jobs/sync-job");

const PORT = Number(process.env.ADMIN_PORT || config.healthPort || 3300);

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

function buildStatus() {
  const filter = runtimeConfig.getSheetFilter();
  const sec = runtimeConfig.getPollIntervalSec();
  const liveTitles = new Set([...wecomSheet._sheetMetas.values()].map((m) => m.title));
  const sheetsLive = [...wecomSheet._sheetMetas.values()].map((m) => ({
    sheetId: m.sheetId, title: m.title, fields: m.fields.length,
  }));

  // 所有发现的 CS_* 子表（含被 excludes 排除的）
  // 数据来自最近一次 initMeta 缓存的 _docMeta.allSheets；首次启动可能为空
  const prefix = filter.prefix || "CS_";
  const excSet = new Set(filter.excludes || []);
  const discoverable = (wecomSheet._docMeta.allSheets || [])
    .filter((s) => s.title?.startsWith(prefix))
    .map((s) => ({
      sheetId: s.sheet_id,
      title: s.title,
      enabled: !excSet.has(s.title),
      live: liveTitles.has(s.title),
      excluded: excSet.has(s.title),
    }))
    .sort((a, b) => a.title.localeCompare(b.title));

  // 近 24h 统计
  const since = Date.now() - 24 * 3600 * 1000;
  const stats = db.prepare(
    "SELECT status, COUNT(*) n FROM sync_state WHERE updated_at >= ? GROUP BY status"
  ).all(since);
  const counts = { ok: 0, failed: 0, pending: 0 };
  for (const r of stats) counts[r.status] = r.n;
  // 最近 10 条失败
  const recentFailed = db.prepare(
    "SELECT row_id, business_key, last_error, attempts, updated_at FROM sync_state WHERE status='failed' ORDER BY updated_at DESC LIMIT 10"
  ).all();
  return {
    docid: config.wecom.sheet.docid,
    filter,
    pollIntervalSec: sec,
    rowCooldownSec: runtimeConfig.getRowCooldownSec(),
    sheetsLive,
    discoverable,
    counts24h: counts,
    recentFailed,
    notifyEnabled: runtimeConfig.isNotifyEnabled(),
    dirtySince: dbApi.getSheetDirtySince(),
    lastRunAt: dbApi.getLastRunAt(),
  };
}

function makeHandler({ reschedule }) {
  return async (req, res) => {
    const u = new URL(req.url, "http://x");
    try {
      if (u.pathname === "/health") {
        return json(res, 200, { ok: true, ts: Date.now() });
      }
      if (u.pathname === "/api/status" && req.method === "GET") {
        return json(res, 200, buildStatus());
      }
      if (u.pathname === "/api/sheets" && req.method === "POST") {
        // 兼容旧接口：传空 names 视为回到"按 prefix 自动发现 + 黑名单 excludes"模式
        reschedule();
        await wecomSheet.initMeta({ force: true });
        return json(res, 200, { ok: true, mode: "auto-discover" });
      }
      if (u.pathname === "/api/interval" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const saved = runtimeConfig.setPollIntervalSec(body.sec);
        const sch = reschedule();
        return json(res, 200, { ok: true, sec: saved, poller: sch });
      }
      if (u.pathname === "/api/cooldown" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const saved = runtimeConfig.setRowCooldownSec(body.sec);
        logger.info("[admin] 录入冷静期 → %d 秒", saved);
        return json(res, 200, { ok: true, sec: saved });
      }
      if (u.pathname === "/api/run-now" && req.method === "POST") {
        const result = await syncJob.processPendingImports();
        if (result?.error) return json(res, 500, { ok: false, error: result.error });
        return json(res, 200, { ok: true, fired: (result.total || 0) > 0, result });
      }
      if (u.pathname === "/api/sheet-toggle" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const r = runtimeConfig.toggleSheet(body.title, !!body.enabled);
        reschedule();
        await wecomSheet.initMeta({ force: true });
        logger.info("[admin] 单表切换 %s → %s", body.title, body.enabled ? "ON" : "OFF");
        const protectedByDefault = body.title === "CS_IT" && !!body.enabled;
        return json(res, 200, {
          ok: true,
          ...r,
          protectedByDefault,
          message: protectedByDefault ? "CS_IT 受默认黑名单保护，当前仍不会被监听" : undefined,
        });
      }
      if (u.pathname === "/api/refresh-sheets" && req.method === "POST") {
        await wecomSheet.initMeta({ force: true });
        return json(res, 200, { ok: true });
      }
      if (u.pathname === "/api/notify" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const on = runtimeConfig.setNotifyEnabled(!!body.enabled);
        logger.info("[admin] 通知开关 → %s", on ? "ON" : "OFF");
        return json(res, 200, { ok: true, enabled: on });
      }
      if (u.pathname === "/api/required-fields" && req.method === "GET") {
        const allSpecs = config.getAllFieldSpecs();
        const override = runtimeConfig.getRequiredFieldsOverride();
        const selected = override || allSpecs.filter((s) => s.defaultRequired).map((s) => s.source);
        return json(res, 200, { fields: allSpecs, override, selected });
      }
      if (u.pathname === "/api/required-fields" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const selected = Array.isArray(body.selected) ? body.selected : [];
        // 空选集底线校验：防止误点"保存"一键把所有非锁定必填清空
        // 客户端必须显式带 confirmedEmpty=true 表示"我清楚自己在干什么"
        if (selected.length === 0 && !body.confirmedEmpty) {
          return json(res, 400, {
            error: "empty_selection_requires_confirm",
            message: "selected 为空数组会把所有非锁定必填字段改为可选，需要带 confirmedEmpty:true 确认",
          });
        }
        const cleaned = runtimeConfig.setRequiredFieldsOverride(selected);
        logger.info("[admin] 必填字段配置已更新: %d 个", cleaned.length);
        return json(res, 200, { ok: true, selected: cleaned });
      }
      if (u.pathname === "/api/required-fields/reset" && req.method === "POST") {
        runtimeConfig.resetRequiredFieldsOverride();
        logger.info("[admin] 必填字段配置已重置为 field-map 默认");
        return json(res, 200, { ok: true, reset: true });
      }
      if (u.pathname === "/" || u.pathname === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(HTML);
      }
      res.writeHead(404).end("not found");
    } catch (e) {
      logger.error("[admin] %s %s → %s", req.method, u.pathname, e.stack || e);
      json(res, 500, { error: e.message });
    }
  };
}

function start({ reschedule }) {
  const server = http.createServer(makeHandler({ reschedule }));
  server.requestTimeout = 10000;
  server.listen(PORT, () => {
    logger.info("[admin] UI 已启动 端口 %d", PORT);
  });
  return server;
}

// ---------- 内嵌单页 HTML ----------
const HTML = `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><title>同步控制台</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:24px;color:#222;background:#fafafa}
  h1{font-size:20px;margin:0 0 20px;letter-spacing:0.5px}
  h2{font-size:14px;margin:20px 0 12px;color:#555;font-weight:600}
  .card{background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.06);border-radius:8px;padding:18px;margin-bottom:18px}
  .row{display:flex;gap:12px;align-items:center;margin:10px 0}
  label{min-width:110px;color:#666}
  input[type=text],input[type=number]{flex:1;padding:7px 11px;border:1px solid #d1d5db;border-radius:5px;font:inherit;transition:border .2s}
  input[type=text]:focus,input[type=number]:focus{outline:none;border-color:#2563eb}
  button{padding:7px 16px;border:0;border-radius:5px;background:#16a34a;color:#fff;cursor:pointer;font:inherit;font-weight:500;transition:background .15s,transform .08s,box-shadow .08s;box-shadow:0 1px 2px rgba(0,0,0,.08)}
  button:hover{background:#15803d}
  button:active{transform:translateY(1px);box-shadow:0 0 0 rgba(0,0,0,0);filter:brightness(.92)}
  button.sec{background:#2563eb}
  button.sec:hover{background:#1d4ed8}
  button.danger{background:#dc2626}
  button.danger:hover{background:#b91c1c}
  button:disabled{opacity:.5;cursor:not-allowed}
  .btn-status{display:inline-block;margin-left:10px;font-size:12px;color:#16a34a;opacity:0;transition:opacity .25s;min-height:16px}
  .btn-status.show{opacity:1}
  .btn-status.err{color:#dc2626}
  .kv{display:grid;grid-template-columns:140px 1fr;gap:8px 18px;font-size:13px}
  .muted{color:#888}.ok{color:#16a34a}.bad{color:#dc2626}
  pre{background:#f5f5f5;padding:11px;border-radius:5px;overflow:auto;font-size:12px;margin:0}
  table{width:100%;border-collapse:collapse;font-size:12px}
  td,th{padding:7px 9px;border-bottom:1px solid #e5e7eb;text-align:left}
  .field-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;margin:12px 0}
  .field-item{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:5px;background:#fafafa;transition:background .2s}
  .field-item:hover{background:#f3f4f6}
  .field-item.locked{background:#fef3c7;cursor:not-allowed}
  .field-item input[type=checkbox]{margin:0}
  .field-item label{min-width:0;flex:1;cursor:pointer;font-size:13px;color:#374151}
  .field-item.locked label{color:#92400e;cursor:not-allowed}
  .toast{position:fixed;top:20px;right:20px;background:#16a34a;color:#fff;padding:12px 18px;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.15);opacity:0;transition:opacity .3s;pointer-events:none;z-index:9999}
  .toast.show{opacity:1}
</style>
</head><body>
<h1>📋 企微 → ZOHO 同步控制台</h1>

<div class="card">
  <h2>当前状态</h2>
  <div id="status" class="kv muted">加载中...</div>
</div>

<div class="card">
  <h2>监听的子表</h2>
  <div class="muted" style="margin-bottom:8px">
    默认监听所有 <code>CS_</code> 开头子表（除黑名单外）。点开关切换；如有新表未自动发现，点"刷新发现"
  </div>
  <div id="sheetList" class="muted">加载中...</div>
  <div class="row" style="margin-top:12px">
    <label>添加新表</label>
    <input type="text" id="newSheetName" placeholder="子表标题，例如 CS_Alice">
    <button onclick="addSheet(this)">启用</button>
    <button class="sec" onclick="refreshSheets(this)">刷新发现</button>
    <span id="sheetBtnStatus" class="btn-status"></span>
  </div>
</div>

<div class="card">
  <h2>同步触发</h2>
  <div class="muted" style="margin-bottom:12px">
    <b>实时触发模式</b>：用户在企微表格「是否确定导入」列选择「导入」后，系统立即执行同步（3秒防抖）。<br>
    成功后「导入状态」显示「导入成功」；失败后显示「导入失败: 原因」，用户修改数据后会自动重试。
  </div>
  <div class="row">
    <button class="sec" onclick="runNow(this)">立即同步一次</button>
    <span id="intervalBtnStatus" class="btn-status"></span>
  </div>
  <div class="muted">扫描所有「是否确定导入」=「导入」的行并批量处理</div>
</div>

<div class="card">
  <h2>企微通知（小智机器人）</h2>
  <div class="row">
    <label>失败/日报推送</label>
    <label style="min-width:auto"><input type="checkbox" id="notifyEnabled" onchange="saveNotify()"> 开启</label>
    <span id="notifyState" class="muted">-</span>
  </div>
  <div class="muted">关闭时：失败事件仍记录到 DB（可在下方"最近失败"看到），但不发企微消息</div>
</div>

<div class="card">
  <h2>录单必填字段（在线表格列）</h2>
  <div class="muted" style="margin-bottom:12px">
    勾选的列 = 在企微表格录单时<b>必须填写</b>，否则该行同步会被拒绝并标红。<br>
    「主题」是 ZOHO 系统硬性要求，强制勾选🔒不可取消；其他均为<b>业务必填</b>，按需调整。
  </div>
  <div style="background:#eff6ff;border-left:3px solid #2563eb;padding:10px 14px;margin-bottom:14px;border-radius:4px;font-size:12px;color:#1e40af">
    <b>📌 后端自动处理的字段（无需配置、无需录入）</b><br>
    • <b>文件编号</b>（field73）：每条订单写 ZOHO 前由后端按 <code>IN/NP/&lt;客户编号&gt;/&lt;5位随机&gt;/&lt;年&gt;</code> 自动生成，本地查重，永不重复。<br>
    • <b>记录归属人</b>（Owner）：固定使用 <code>ZOHO_DEFAULT_OWNER_EMAIL</code> 配置的负责人。
  </div>
  <div id="requiredFieldsGrid" class="field-grid muted">加载中...</div>
  <div class="row" style="margin-top:16px">
    <button onclick="saveRequiredFields(this)">保存</button>
    <button class="danger" onclick="resetRequiredFields(this)">恢复 field-map 默认</button>
    <span id="reqFieldsBtnStatus" class="btn-status"></span>
  </div>
</div>

<div class="card">
  <h2>近 24 小时</h2>
  <div id="counts" class="kv muted"></div>
</div>

<div class="card">
  <h2>最近失败（最多 10 条）</h2>
  <div id="recentFailed">-</div>
</div>

<script>
async function refresh(){
  const r = await fetch('/api/status'); const s = await r.json();
  window._lastStatus = s;
  document.getElementById('status').innerHTML =
    '<div>docid</div><div>'+s.docid+'</div>'+
    '<div>触发模式</div><div>实时触发（webhook）</div>'+
    '<div>生效子表</div><div>'+(s.sheetsLive.map(x=>x.title).join(', ')||'(尚未初始化)')+'</div>'+
    '<div>筛选规则</div><div>prefix='+s.filter.prefix+' 黑名单=['+(s.filter.excludes||[]).join(',')+']</div>';
  // 子表开关列表
  if (!s.discoverable || !s.discoverable.length) {
    document.getElementById('sheetList').innerHTML = '<div class="muted">尚未发现子表，点"刷新发现"</div>';
  } else {
    document.getElementById('sheetList').innerHTML = s.discoverable.map(d =>
      '<div class="row" style="margin:4px 0">'+
      '<label style="min-width:180px;color:#222">'+d.title+
      (d.live?' <span class="ok" style="font-size:11px">●live</span>':'')+
      (d.excluded?' <span class="muted" style="font-size:11px">(黑名单)</span>':'')+'</label>'+
      '<label style="min-width:auto"><input type="checkbox" '+(d.enabled?'checked':'')+
      ' onchange="toggleSheet(\\''+d.title+'\\', this.checked)"> 监听</label>'+
      '</div>'
    ).join('');
  }
  // 不再需要 intervalSec 和 cooldownSec 的赋值
  document.getElementById('notifyEnabled').checked = !!s.notifyEnabled;
  document.getElementById('notifyState').textContent = s.notifyEnabled ? '✅ 已开启' : '🔕 已关闭';
  document.getElementById('notifyState').className = s.notifyEnabled ? 'ok' : 'muted';
  document.getElementById('counts').innerHTML =
    '<div>成功</div><div class="ok">'+s.counts24h.ok+'</div>'+
    '<div>失败</div><div class="bad">'+s.counts24h.failed+'</div>'+
    '<div>待处理</div><div>'+(s.counts24h.pending||0)+'</div>';
  const rf = s.recentFailed;
  if (!rf.length) document.getElementById('recentFailed').innerHTML = '<div class="muted">无</div>';
  else {
    const rows = rf.map(r =>
      '<tr><td>'+(r.business_key||'-')+'</td><td class="bad">'+(r.last_error||'').slice(0,120)+'</td><td>'+r.attempts+'</td><td>'+new Date(r.updated_at).toLocaleString()+'</td></tr>'
    ).join('');
    document.getElementById('recentFailed').innerHTML =
      '<table><tr><th>订单</th><th>错误</th><th>尝试</th><th>最近时间</th></tr>'+rows+'</table>';
  }
}
async function post(path, body){
  const r = await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});
  return r.json();
}
function formatScanState(s){
  const now = Date.now();
  if (s.dirtySince) {
    const ago = Math.max(0, Math.round((now - s.dirtySince) / 1000));
    return '<span class="ok">● 待扫描</span>（'+ago+'s 前有变更，下 tick 处理）';
  }
  if (s.lastRunAt) {
    const ago = Math.max(0, Math.round((now - s.lastRunAt) / 1000));
    return '<span class="muted">○ 空闲</span>（'+ago+'s 前跑过一轮）';
  }
  return '<span class="muted">尚未跑过同步</span>';
}
function flashStatus(spanId, msg, isErr){
  const s = document.getElementById(spanId);
  if (!s) return;
  s.textContent = msg;
  s.className = 'btn-status show' + (isErr ? ' err' : '');
  clearTimeout(s._t);
  s._t = setTimeout(() => { s.className = 'btn-status' + (isErr ? ' err' : ''); }, 2500);
}
async function toggleSheet(title, enabled){
  // CS_IT 是默认黑名单（业务上不参与同步），用户启用前确认一次
  if (enabled && title === 'CS_IT') {
    if (!confirm('CS_IT 默认是黑名单（IT 内部表，不属于业务订单）。确定要启用监听吗？')) {
      refresh();  // 复位 checkbox
      return;
    }
  }
  const res = await post('/api/sheet-toggle', {title, enabled});
  if (res?.protectedByDefault) flashStatus('sheetBtnStatus', res.message || 'CS_IT 受默认黑名单保护', true);
  else flashStatus('sheetBtnStatus', '✓ ' + title + ' 已' + (enabled ? '启用' : '关闭'));
  refresh();
}
async function addSheet(btn){
  const t = document.getElementById('newSheetName').value.trim();
  if (!t) { flashStatus('sheetBtnStatus', '请填子表名', true); return; }
  // 先刷新一次发现，让企微端最新子表纳入；然后 toggle 确保不在黑名单
  await post('/api/refresh-sheets');
  await post('/api/sheet-toggle', {title: t, enabled: true});
  document.getElementById('newSheetName').value = '';
  flashStatus('sheetBtnStatus', '✓ ' + t + ' 已启用');
  refresh();
}
async function refreshSheets(btn){
  await post('/api/refresh-sheets');
  flashStatus('sheetBtnStatus', '✓ 已刷新');
  refresh();
}
// 删除 saveInterval 和 saveCooldown 函数
async function runNow(btn){
  const r = await post('/api/run-now');
  if (r?.fired === false && r?.reason === 'locked') {
    flashStatus('intervalBtnStatus', '⏳ 已有同步在跑，稍后自动合并', true);
  } else {
    flashStatus('intervalBtnStatus', '✓ 已触发，查看服务端日志');
  }
}
async function saveNotify(){
  const enabled = document.getElementById('notifyEnabled').checked;
  await post('/api/notify', {enabled});
  refresh();
}
let _requiredFieldsState = null;
async function loadRequiredFields(){
  const r = await fetch('/api/required-fields');
  const data = await r.json();
  _requiredFieldsState = data;
  const grid = document.getElementById('requiredFieldsGrid');
  if (!data.fields || !data.fields.length) {
    grid.innerHTML = '<div class="muted">无字段</div>';
    return;
  }
  const selectedSet = new Set(data.selected || []);
  grid.innerHTML = data.fields.map(f => {
    const checked = selectedSet.has(f.source);
    const lockedClass = f.locked ? ' locked' : '';
    const disabledAttr = f.locked ? ' disabled' : '';
    const lockIcon = f.locked ? ' 🔒' : '';
    const title = f.locked ? 'title="系统强制必填，不可取消"' : '';
    return '<div class="field-item'+lockedClass+'" '+title+'>'+
      '<input type="checkbox" id="req_'+f.source+'" '+(checked?'checked':'')+disabledAttr+'>'+
      '<label for="req_'+f.source+'">'+f.source+' → '+f.target+lockIcon+'</label>'+
      '</div>';
  }).join('');
}
async function saveRequiredFields(btn){
  if (!_requiredFieldsState) return;
  const fields = _requiredFieldsState.fields;
  const selected = fields
    .filter(f => document.getElementById('req_'+f.source)?.checked)
    .map(f => f.source);

  // 警告 1：field-map 默认必填的业务字段被取消
  const droppedDefaults = fields
    .filter(f => f.defaultRequired && !f.locked && !selected.includes(f.source))
    .map(f => f.source);
  if (droppedDefaults.length) {
    const ok = confirm('你取消了以下 field-map.json 里默认必填的业务字段：\\n  - ' +
      droppedDefaults.join('\\n  - ') +
      '\\n\\n取消后这些字段空值也会同步成功，确定继续？');
    if (!ok) return;
  }

  // 警告 2：selected 为空（只剩锁定字段）
  const nonLocked = selected.filter(s => !fields.find(f => f.source === s && f.locked));
  let body = { selected };
  if (nonLocked.length === 0) {
    const ok = confirm('你把所有"非锁定"必填字段都取消了。\\n只剩「主题」「渠道名称」（系统强制）会校验，其它字段空值全部允许通过。\\n\\n确定继续？');
    if (!ok) return;
    body.confirmedEmpty = true;
  }

  const r = await post('/api/required-fields', body);
  if (r?.error) {
    flashStatus('reqFieldsBtnStatus', '保存失败: ' + (r.message || r.error), true);
    return;
  }
  flashStatus('reqFieldsBtnStatus', '✓ 已保存 ('+ (r.selected?.length || 0) +' 个必填)');
  await loadRequiredFields();
}
async function resetRequiredFields(btn){
  if (!confirm('确定恢复为 field-map.json 默认配置？')) return;
  await post('/api/required-fields/reset');
  flashStatus('reqFieldsBtnStatus', '✓ 已恢复默认');
  await loadRequiredFields();
}
function showToast(msg){
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}
refresh(); setInterval(refresh, 10000);
loadRequiredFields();
</script>
</body></html>`;

module.exports = { start };
