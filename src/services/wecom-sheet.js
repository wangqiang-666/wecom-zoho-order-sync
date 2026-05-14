/**
 * 企业微信智能表格读/写 —— 多子表版
 *
 * 变更要点（相对单表旧版）：
 *   - meta 从单例 → Map<sheetId, sheetMeta>，支持并行监听多个 CS_* 子表
 *   - 子表发现策略：白名单 override > 前缀匹配（默认 CS_）
 *   - readRows 遍历所有子表返回一个扁平列表，rowId 已含 sheetId 天然隔离
 *   - updateStatus 从 rowId 解出 sheetId 路由到对应子表
 *   - Reference 字典跨子表共享（docid 级别的，字典子表本就是全局）
 *
 * 契约保持：readRows()/updateStatus() 的签名对上层（sync-job）透明不变。
 */

const crypto = require("crypto");
const config = require("../config");
const logger = require("../utils/logger");
const runtimeConfig = require("../utils/runtime-config");

const STATUS_FIELD_TITLE = "导入状态";
const CONFIRM_IMPORT_FIELD_TITLE = "是否确定导入";  // 注意：是"确定"不是"确认"

const STATUS_SUCCESS = "导入成功";
const STATUS_FAILED  = "导入失败";
const STATUS_PENDING = "导入中";

const API_BASE = "https://qyapi.weixin.qq.com";

// ---------- access_token ----------
let _token = null, _exp = 0, _refreshPromise = null;
async function getToken() {
  if (_token && Date.now() < _exp) return _token;
  if (_refreshPromise) return _refreshPromise;
  _refreshPromise = (async () => {
    const url = `${API_BASE}/cgi-bin/gettoken?corpid=${config.wecom.corpId}&corpsecret=${config.wecom.agentSecret}`;
    const j = await (await fetch(url)).json();
    if (j.errcode !== 0) throw new Error(`获取 access_token 失败: ${j.errmsg}`);
    _token = j.access_token;
    _exp = Date.now() + Math.max(0, j.expires_in - 300) * 1000;
    return _token;
  })().finally(() => { _refreshPromise = null; });
  return _refreshPromise;
}

async function api(path, body) {
  const token = await getToken();
  const r = await fetch(
    `${API_BASE}/cgi-bin/wedoc/smartsheet/${path}?access_token=${token}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
  const j = await r.json();
  if (j.errcode !== 0) {
    const err = new Error(`企微 ${path} 调用失败 [${j.errcode}]: ${j.errmsg}`);
    err.errcode = j.errcode;
    throw err;
  }
  return j;
}

// ---------- 写操作串行队列（按 sheetId 隔离）----------
// 背景：企微 SmartsheetV2 对同一文档高并发 update_records 会返回 [2040035] Service Error。
// 实测在 4 worker 并发下，回写状态密集触发就会大量假失败，进而被上层错误地标成"ZOHO写入失败"，
// 极端情况下会让下一轮 sync 误判为"未成功"重新创建 → 重复 ZOHO 记录（灾难性）。
// 策略：
//   - 不同 sheetId 互不阻塞（CS_Rose / CS_Nick 仍然可以同时回写，吞吐不崩）
//   - 同一 sheetId 内串行（一个个回写，企微服务端不会过载）
//   - 遇到 2040035 / 限流类错误自动指数退避重试 3 次
const _sheetWriteQueues = new Map(); // sheetId -> Promise (chain tail)

async function _retryableWrite(label, fn) {
  // 已知会偶发的服务端错误，重试是安全的（操作幂等：写同一 record 同一字段同一值）
  const RETRIABLE = new Set([2040035, -1, 45009, 50001]);
  const delays = [300, 800, 2000];
  let lastErr;
  for (let i = 0; i <= delays.length; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const code = e.errcode;
      const retriable = RETRIABLE.has(code);
      if (!retriable || i === delays.length) {
        if (retriable) logger.warn("[wecom-sheet] %s 重试 %d 次后仍失败: %s", label, delays.length, e.message);
        throw e;
      }
      logger.warn("[wecom-sheet] %s 第%d次失败 [%s]，%dms 后重试", label, i + 1, code, delays[i]);
      await new Promise(r => setTimeout(r, delays[i]));
    }
  }
  throw lastErr;
}

function _enqueueWrite(sheetId, label, fn) {
  const prev = _sheetWriteQueues.get(sheetId) || Promise.resolve();
  // 注意：本任务的 settle 不能让链路炸 —— 任意一个失败不影响后续任务排队
  const next = prev.catch(() => {}).then(() => _retryableWrite(label, fn));
  _sheetWriteQueues.set(sheetId, next);
  // 队列尾自然 GC：next 完成后如果它仍然是当前尾，就清掉避免 Map 永久持引用
  next.finally(() => {
    if (_sheetWriteQueues.get(sheetId) === next) _sheetWriteQueues.delete(sheetId);
  });
  return next;
}

// ---------- 多子表元数据缓存 ----------
// docid 级共享状态
const docMeta = {
  docid: config.wecom.sheet.docid,
  allSheets: [],                          // docid 下所有子表（含字典表）
};
// 目标子表（CS_* 或白名单），按 sheetId 索引
const sheetMetas = new Map();
// sheetMeta 结构: { sheetId, title, fields, fieldByTitle, statusFieldId, confirmImportFieldId, refResolvers }

// Reference 字典缓存（按 sub_id 分别缓存 —— 不同子表的同名 ref 字段可能指向不同字典）
const _refCacheBySubId = {};   // subId -> { recordId: displayText }
const _refDictMetaBySubId = {}; // subId -> { sheetId, title }
const _refReloadingBySubId = {};

// 字典定时刷新：进程内字典缓存只在启动时加载，遇到"未知 record_id"才重载。
// 历史问题：如果字典里某条已存在的条目被改名（record_id 不变，名字变了），
// 后端缓存永远拿不到新名字，会持续把旧名字写入下游系统（已发生过 96 单错渠道事故）。
// 修复：每 REF_REFRESH_INTERVAL_MS 主动全量重载一次，原子替换缓存，失败不影响主链路。
const REF_REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10 分钟
let _refRefreshTimer = null;

function flattenCell(val) {
  if (val === null || val === undefined) return "";
  if (Array.isArray(val) && val.length && val[0]?.text !== undefined) {
    // 文本/富文本/Reference resolved 都是 [{text:"..."}] 形式，统一拼接
    return val.map((x) => x.text ?? "").join("");
  }
  if (Array.isArray(val) && val.length && typeof val[0] === "string") {
    return val.join(";");
  }
  if (typeof val === "number") return String(val);
  if (typeof val === "string") return val;
  if (typeof val === "boolean") return val ? "是" : "否";
  if (Array.isArray(val) && val.length === 0) return "";
  return JSON.stringify(val);
}

/**
 * 根据运行时配置决定哪些子表要纳入监听
 * 规则：所有 title 以 prefix 开头的子表，再去掉 excludes 黑名单
 */
function pickTargetSheets(allSheets) {
  const { prefix, excludes } = runtimeConfig.getSheetFilter();
  const excSet = new Set(excludes || []);
  return allSheets.filter((s) => s.title.startsWith(prefix) && !excSet.has(s.title));
}

async function initMeta({ force = false } = {}) {
  if (!force && sheetMetas.size > 0) return;

  logger.info("[wecom-sheet] 拉取 docid=%s 所有子表...", docMeta.docid);
  const sheets = await api("get_sheet", { docid: docMeta.docid, need_all_type_sheet: true });
  docMeta.allSheets = sheets.sheet_list;

  const targets = pickTargetSheets(sheets.sheet_list);
  if (!targets.length) {
    const filter = runtimeConfig.getSheetFilter();
    throw new Error(
      `docid=${docMeta.docid} 下没有匹配的目标子表（filter=${JSON.stringify(filter)}）` +
      `；可见子表：${sheets.sheet_list.map((s) => s.title).join(", ")}`
    );
  }

  sheetMetas.clear();
  for (const t of targets) {
    const sm = await initSheetMeta(t);
    sheetMetas.set(sm.sheetId, sm);
  }

  // 所有子表字段扫完后统一准备 Reference 字典（跨表共享）
  await prepareReferenceResolvers();

  // 字典定时刷新（幂等：内部判断已启动则跳过；force 重新 init 不会重复启动）
  startRefRefreshTimer();

  logger.info("[wecom-sheet] ✅ 元数据就绪 目标子表=%d [%s]",
    sheetMetas.size, [...sheetMetas.values()].map((m) => m.title).join(", "));
}

async function initSheetMeta(sheetInfo) {
  const fields = await api("get_fields", {
    docid: docMeta.docid, sheet_id: sheetInfo.sheet_id, offset: 0, limit: 1000,
  });
  const fieldByTitle = Object.fromEntries(fields.fields.map((f) => [f.field_title, f]));

  const statusField = fieldByTitle[STATUS_FIELD_TITLE];
  if (!statusField) {
    throw new Error(`子表「${sheetInfo.title}」缺少「${STATUS_FIELD_TITLE}」列`);
  }

  const confirmImportField = fieldByTitle[CONFIRM_IMPORT_FIELD_TITLE];
  if (!confirmImportField) {
    throw new Error(`子表「${sheetInfo.title}」缺少「${CONFIRM_IMPORT_FIELD_TITLE}」列`);
  }

  // field-map 校验
  const mapSources = config.fieldMap.fields.map((m) => m.source);
  const missing = mapSources.filter((s) => !fieldByTitle[s]);
  if (missing.length) {
    throw new Error(`子表「${sheetInfo.title}」缺少映射字段：${missing.join(", ")}`);
  }
  const mapSet = new Set(mapSources);
  const extra = fields.fields.filter((f) => !mapSet.has(f.field_title)).map((f) => f.field_title);
  if (extra.length) {
    logger.debug("[wecom-sheet] 子表「%s」未映射的字段（忽略）: %s",
      sheetInfo.title, extra.join(", "));
  }

  return {
    sheetId: sheetInfo.sheet_id,
    title: sheetInfo.title,
    fields: fields.fields,
    fieldByTitle,
    statusFieldId: statusField.field_id,
    confirmImportFieldId: confirmImportField.field_id,
    refResolvers: {},  // 填充见 prepareReferenceResolvers
  };
}

/**
 * Reference 字典按 sub_id 分别缓存（不同子表同名 ref 字段可能指向不同字典子表）
 * 每个 sheetMeta.refResolvers[fieldTitle] 绑定自己 sub_id 的字典。
 */
async function prepareReferenceResolvers() {
  const sheetById = Object.fromEntries(docMeta.allSheets.map((s) => [s.sheet_id, s]));

  // 先收齐所有 (sheetMeta, refField) 对，去重按 sub_id 加载字典
  const subIdsToLoad = new Set();
  const bindings = []; // { sm, fieldTitle, subId }
  for (const sm of sheetMetas.values()) {
    for (const f of sm.fields) {
      if (f.field_type !== "FIELD_TYPE_REFERENCE") continue;
      const subId = f.property_reference?.sub_id;
      if (!subId) {
        logger.warn("[wecom-sheet] 子表「%s」Reference 字段「%s」无 sub_id，跳过",
          sm.title, f.field_title);
        continue;
      }
      bindings.push({ sm, fieldTitle: f.field_title, subId });
      subIdsToLoad.add(subId);
    }
  }

  // 加载所有用到的字典（按 sub_id 去重，同一字典被多子表引用只加载一次）
  for (const subId of subIdsToLoad) {
    if (_refCacheBySubId[subId]) continue;
    const dictSheet = sheetById[subId] || { sheet_id: subId, title: `(sub_id=${subId})` };
    _refDictMetaBySubId[subId] = { sheetId: dictSheet.sheet_id, title: dictSheet.title };
    _refCacheBySubId[subId] = await loadDictSheet(dictSheet);
    logger.debug("[wecom-sheet] 字典 sub_id=%s「%s」加载 %d 项",
      subId, dictSheet.title, Object.keys(_refCacheBySubId[subId]).length);
  }

  // 给每个 (sheetMeta, fieldTitle) 绑定自己 sub_id 的 resolver
  for (const { sm, fieldTitle, subId } of bindings) {
    sm.refResolvers[fieldTitle] = (recordIds) => {
      const cache = _refCacheBySubId[subId] || {};
      const out = recordIds.map((rid) => cache[rid] || `(未知:${rid})`);
      if (out.some((t) => t.startsWith("(未知:")) && !_refReloadingBySubId[subId]) {
        _refReloadingBySubId[subId] = (async () => {
          logger.warn("[wecom-sheet] 字典 sub_id=%s 有未知 record_id，异步重载...", subId);
          try {
            const fresh = await loadDictSheet(_refDictMetaBySubId[subId]);
            _refCacheBySubId[subId] = fresh;
            logger.info("[wecom-sheet] 字典 sub_id=%s 刷新: %d 项", subId, Object.keys(fresh).length);
          } catch (e) {
            logger.error("[wecom-sheet] 字典 sub_id=%s 刷新失败: %s", subId, e.message);
          } finally {
            _refReloadingBySubId[subId] = null;
          }
        })();
      }
      return out;
    };
  }
}

async function loadDictSheet(dictSheet) {
  const sheetId = dictSheet.sheetId || dictSheet.sheet_id;
  const fields = await api("get_fields", { docid: docMeta.docid, sheet_id: sheetId, offset: 0, limit: 100 });
  if (!fields.fields?.length) return {};
  const titleField = fields.fields[0];

  const out = {};
  let offset = 0;
  for (let safety = 0; safety < 100; safety++) {
    const r = await api("get_records", {
      docid: docMeta.docid, sheet_id: sheetId,
      key_type: "CELL_VALUE_KEY_TYPE_FIELD_TITLE",
      offset, limit: 200,
    });
    for (const rec of r.records || []) {
      out[rec.record_id] = flattenCell(rec.values[titleField.field_title]);
    }
    if (!r.has_more) break;
    offset += (r.records || []).length;

    if (safety === 99) {
      logger.warn("[wecom-sheet] 字典「%s」达到100页限制，可能有数据未加载完整", dictSheet.title);
    }
  }
  return out;
}

// 定时刷新所有 Reference 字典：
// 单次失败不影响下次定时；单个字典失败不影响其他字典；新缓存原子替换旧缓存（不会出现读到一半的状态）。
// 设计上故意使用 setTimeout 链式调度而不是 setInterval：
//   - 重载本身可能耗时（多个字典加起来可能 10s+），interval 会堆积；
//   - 链式调度保证"上次完成 → 等10分钟 → 下次开始"，不会并发跑。
async function refreshAllRefDicts() {
  const subIds = Object.keys(_refDictMetaBySubId);
  if (!subIds.length) return;
  const startedAt = Date.now();
  let okCount = 0;
  let failCount = 0;
  let changedCount = 0;
  for (const subId of subIds) {
    try {
      const fresh = await loadDictSheet(_refDictMetaBySubId[subId]);
      const old = _refCacheBySubId[subId] || {};
      // 检测改名：record_id 相同但显示名变了，是这次修复要解决的核心问题，单独打日志
      let renamed = 0;
      for (const rid of Object.keys(fresh)) {
        if (old[rid] !== undefined && old[rid] !== fresh[rid]) renamed += 1;
      }
      _refCacheBySubId[subId] = fresh; // 原子替换
      okCount += 1;
      if (renamed > 0) {
        changedCount += renamed;
        logger.info("[wecom-sheet] 字典 sub_id=%s「%s」检测到 %d 条改名，已应用最新名称",
          subId, _refDictMetaBySubId[subId].title, renamed);
      }
    } catch (e) {
      failCount += 1;
      logger.warn("[wecom-sheet] 定时刷新字典 sub_id=%s 失败（保留旧缓存）: %s", subId, e.message);
    }
  }
  logger.info("[wecom-sheet] 字典定时刷新完成 ok=%d fail=%d 改名=%d 耗时=%dms",
    okCount, failCount, changedCount, Date.now() - startedAt);
}

function startRefRefreshTimer() {
  if (_refRefreshTimer) return; // 进程内幂等，重复调用安全
  const tick = () => {
    refreshAllRefDicts()
      .catch((e) => logger.error("[wecom-sheet] 字典定时刷新意外异常: %s", e.message))
      .finally(() => {
        _refRefreshTimer = setTimeout(tick, REF_REFRESH_INTERVAL_MS);
        if (_refRefreshTimer.unref) _refRefreshTimer.unref(); // 不阻挡进程退出
      });
  };
  _refRefreshTimer = setTimeout(tick, REF_REFRESH_INTERVAL_MS);
  if (_refRefreshTimer.unref) _refRefreshTimer.unref();
  logger.info("[wecom-sheet] 字典定时刷新已启动: 每 %d 分钟", REF_REFRESH_INTERVAL_MS / 60000);
}

// ---------- 业务行哈希 ----------
// 排除"导入状态"列：程序自己回写状态会让 hash 抖动，
// 用户单纯清状态列也不应该算"内容变化"。只有真业务字段变了才让 hash 变。
function hashRow(rowData) {
  const sorted = Object.keys(rowData)
    .filter((k) => k !== STATUS_FIELD_TITLE)
    .sort()
    .map((k) => `${k}=${rowData[k] ?? ""}`)
    .join("|");
  return crypto.createHash("sha1").update(sorted).digest("hex");
}

// ---------- readRows（跨所有目标子表） ----------
async function readRows() {
  await initMeta();

  // ⚡ 性能关键：所有子表并行读取
  // 之前是串行 for-of，8 个子表 × 每个 ~1s 往返 = 8-10s，是端到端延迟的最大瓶颈。
  // 并行后总耗时 ≈ 最慢那个子表的耗时（~1-2s），提速 5-8 倍。
  // 质量不受影响：每个子表的 get_records 彼此独立，企微服务端对同文档不同 sheet 的读不冲突。
  const perSheet = await Promise.all(
    Array.from(sheetMetas.values()).map(async (sm) => {
      const all = [];
      let offset = 0;
      for (let safety = 0; safety < 100; safety++) {
        const r = await api("get_records", {
          docid: docMeta.docid, sheet_id: sm.sheetId,
          key_type: "CELL_VALUE_KEY_TYPE_FIELD_TITLE",
          offset, limit: 200,
        });
        for (const rec of r.records || []) all.push(rec);
        if (!r.has_more) break;
        offset += (r.records || []).length;
        if (safety === 99) {
          logger.warn("[wecom-sheet] 子表「%s」达到100页限制，可能有数据未加载完整", sm.title);
        }
      }
      return { sm, all };
    })
  );

  const out = [];
  let globalIdx = 0;
  for (const { sm, all } of perSheet) {
    let taken = 0;
    for (const rec of all) {
      const data = {};
      for (const f of sm.fields) {
        const raw = rec.values[f.field_title];
        if (f.field_type === "FIELD_TYPE_REFERENCE" && Array.isArray(raw) && raw.length && typeof raw[0] === "string") {
          const resolver = sm.refResolvers[f.field_title];
          data[f.field_title] = resolver ? resolver(raw).join(";") : raw.join(";");
        } else {
          data[f.field_title] = flattenCell(raw);
        }
      }
      // 公式字段「主题」后端 derive
      if (!data["主题"] || String(data["主题"]).trim() === "") {
        const zhuti = String(data["公证主体中文名"] || "").trim();
        const seq = String(data["第几单"] || "").trim();
        if (zhuti || seq) data["主题"] = `${zhuti}${seq}`;
      }

      // 未明确点击「导入」时，缺少技术门槛字段视为录入中，避免半填行被轮询打扰。
      // 已点击「导入」的行必须继续进入同步校验，让用户在状态列看到明确失败原因。
      const subject = String(data["主题"] || "").trim();
      const channel = String(data["渠道名称"] || "").trim();
      const confirmImport = String(data[CONFIRM_IMPORT_FIELD_TITLE] || "").trim();
      if ((!subject || !channel) && confirmImport !== "导入") continue;

      const status = data[STATUS_FIELD_TITLE];
      globalIdx++;
      taken++;
      out.push({
        rowId: `wecom::${sm.sheetId}::${rec.record_id}`,
        recordId: rec.record_id,
        rowIndex: globalIdx,
        sheetTitle: sm.title,   // 新增：方便日志识别哪位同事的订单
        status,
        data,
        hash: hashRow(data),
      });
    }
    logger.info("[wecom-sheet] 子表「%s」读取 %d 行（含空行过滤前 %d）", sm.title, taken, all.length);
  }
  logger.info("[wecom-sheet] 合计 %d 行（%d 个子表）", out.length, sheetMetas.size);
  return out;
}

// ---------- updateStatus（按 rowId 路由到对应子表） ----------
async function updateStatus(rowId, status, detail) {
  await initMeta();
  const parts = rowId.split("::");
  const sheetId = parts[1];
  const recordId = parts[2];
  const sm = sheetMetas.get(sheetId);
  if (!sm) throw new Error(`updateStatus: 未找到子表 sheetId=${sheetId}`);

  let text = status;
  if (detail) {
    if (status === STATUS_SUCCESS) text = `${status} (zoho=${detail})`;
    else if (status === STATUS_FAILED) text = `${status}: ${detail}`;
  }
  // 走串行队列：同 sheetId 内串行 + 失败自动重试，避免企微 SmartsheetV2 高并发限流
  await _enqueueWrite(sheetId, `updateStatus(${sm.title}/${recordId})`, () => api("update_records", {
    docid: docMeta.docid, sheet_id: sm.sheetId,
    key_type: "CELL_VALUE_KEY_TYPE_FIELD_ID",
    records: [{
      record_id: recordId,
      values: { [sm.statusFieldId]: [{ type: "text", text }] },
    }],
  }));
  logger.debug("[wecom-sheet] 「%s」回写状态: %s → %s", sm.title, recordId, text);
}

/**
 * 热重载：Web UI 改了子表清单后调一下，下一次 readRows 会重新扫
 */
function invalidateMeta() {
  sheetMetas.clear();
  logger.info("[wecom-sheet] 元数据已失效，下一轮会重新初始化");
}

/**
 * 回写"是否确定导入"列
 */
async function updateConfirmImport(rowId, value) {
  await initMeta();
  const parts = rowId.split("::");
  const sheetId = parts[1];
  const recordId = parts[2];
  const sm = sheetMetas.get(sheetId);
  if (!sm) throw new Error(`updateConfirmImport: 未找到子表 sheetId=${sheetId}`);

  await _enqueueWrite(sheetId, `updateConfirmImport(${sm.title}/${recordId})`, () => api("update_records", {
    docid: docMeta.docid, sheet_id: sm.sheetId,
    key_type: "CELL_VALUE_KEY_TYPE_FIELD_ID",
    records: [{
      record_id: recordId,
      values: { [sm.confirmImportFieldId]: [{ type: "text", text: value }] },
    }],
  }));
  logger.debug("[wecom-sheet] 「%s」回写确认导入: %s → %s", sm.title, recordId, value);
}

module.exports = {
  STATUS_SUCCESS, STATUS_FAILED, STATUS_PENDING,
  initMeta,
  readRows,
  updateStatus,
  updateConfirmImport,
  hashRow,
  invalidateMeta,
  refreshAllRefDicts,  // 供 sync-job 每次同步前主动刷新字典
  api,  // 供测试脚本使用
  // 调试
  _docMeta: docMeta,
  _sheetMetas: sheetMetas,
};
