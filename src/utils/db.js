/**
 * SQLite 状态层
 *
 * 表：
 *   sync_state   - 每条企微表格行的同步状态（去重依据）
 *   notify_queue - 待发送的通知（失败去抖 + 日报汇总数据源）
 */

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const config = require("../config");
const logger = require("./logger");

const dbPath = path.isAbsolute(config.db.path)
  ? config.db.path
  : path.join(__dirname, "..", "..", config.db.path);
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 10000");

db.exec(`
  CREATE TABLE IF NOT EXISTS sync_state (
    row_id         TEXT PRIMARY KEY,        -- 企微表格行唯一ID（优先用 API 返回的 record_id）
    business_key   TEXT,                    -- 业务唯一键（订单确认编号 field235）
    zoho_id        TEXT,                    -- 写入 ZOHO 后的 record id
    status         TEXT NOT NULL,           -- pending / ok / failed
    last_error     TEXT,
    attempts       INTEGER NOT NULL DEFAULT 0,
    payload_hash   TEXT,                    -- 行内容 hash，用于检测修改
    file_no        TEXT,                    -- 后端生成的文件编号（IN/NP/.../.../YYYY）
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sync_state_status ON sync_state(status);
  CREATE INDEX IF NOT EXISTS idx_sync_state_biz ON sync_state(business_key);

  CREATE TABLE IF NOT EXISTS notify_queue (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    kind         TEXT NOT NULL,             -- fail / daily
    payload      TEXT NOT NULL,             -- JSON
    sent_at      INTEGER,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_notify_pending ON notify_queue(sent_at);

  -- 企微回调捕获到的 docid（同一个 docid 多次事件会更新 last_seen）
  CREATE TABLE IF NOT EXISTS wecom_docid (
    docid        TEXT PRIMARY KEY,
    event        TEXT,
    op_user      TEXT,
    raw          TEXT,
    first_seen   INTEGER NOT NULL,
    last_seen    INTEGER NOT NULL
  );

  -- 全量回调事件流水，用于排查
  CREATE TABLE IF NOT EXISTS callback_event_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type   TEXT,
    raw          TEXT NOT NULL,
    received_at  INTEGER NOT NULL
  );

  -- 运行时配置（Web UI 可改，不用重启）
  --   key=sheet_prefix              value=CS_         子表名前缀（匹配所有 CS_* 自动纳入）
  --   key=sheet_excludes             value=CSV         黑名单子表（CS_IT 永远 union，不写入 DB）
  --   key=poll_interval_sec          value=300         轮询间隔（秒）
  --   key=notify_enabled             value=0/1         企微通知总开关
  --   key=required_fields_override   value=JSON array  录单必填字段 override（null=回落 field-map）
  -- 没这张表 → 用 .env 兜底；有值 → DB 优先
  CREATE TABLE IF NOT EXISTS app_config (
    key          TEXT PRIMARY KEY,
    value        TEXT NOT NULL,
    updated_at   INTEGER NOT NULL
  );
`);

// 历史 DB 迁移：sync_state 表原本没有 file_no 列，老实例需要补一列（加不上就是已经有了）
try {
  db.exec(`ALTER TABLE sync_state ADD COLUMN file_no TEXT`);
  logger.info("sync_state 表已添加 file_no 列");
} catch (e) {
  if (!/duplicate column/i.test(e.message)) throw e;
}

// 冷静期支持：last_change_ts 记录该行 hash 上次变化的时间
// processOne 据此判断"是否还在录入中"，避免同事填一半就被校验/同步
try {
  db.exec(`ALTER TABLE sync_state ADD COLUMN last_change_ts INTEGER`);
  logger.info("sync_state 表已添加 last_change_ts 列");
} catch (e) {
  if (!/duplicate column/i.test(e.message)) throw e;
}

const stmts = {
  getByRow: db.prepare("SELECT * FROM sync_state WHERE row_id = ?"),
  findByFileNo: db.prepare("SELECT 1 FROM sync_state WHERE file_no = ? LIMIT 1"),
  upsert: db.prepare(`
    INSERT INTO sync_state (row_id, business_key, zoho_id, status, last_error, attempts, payload_hash, file_no, created_at, updated_at)
    VALUES (@row_id, @business_key, @zoho_id, @status, @last_error, @attempts, @payload_hash, @file_no, @now, @now)
    ON CONFLICT(row_id) DO UPDATE SET
      business_key = excluded.business_key,
      zoho_id      = COALESCE(excluded.zoho_id, sync_state.zoho_id),
      status       = excluded.status,
      last_error   = excluded.last_error,
      attempts     = excluded.attempts,
      payload_hash = excluded.payload_hash,
      file_no      = COALESCE(excluded.file_no, sync_state.file_no),
      updated_at   = excluded.updated_at
  `),
  // 冷静期：仅更新 last_change_ts 和 payload_hash（行还在录入中，不动 status/zoho_id）
  // 给后续 cron tick 判断"是否过了冷静期"用
  touchChange: db.prepare(`
    INSERT INTO sync_state (row_id, business_key, status, attempts, payload_hash, last_change_ts, created_at, updated_at)
    VALUES (@row_id, @business_key, 'pending', 0, @payload_hash, @now, @now, @now)
    ON CONFLICT(row_id) DO UPDATE SET
      payload_hash   = excluded.payload_hash,
      last_change_ts = excluded.last_change_ts,
      updated_at     = excluded.updated_at
  `),
  queueInsert: db.prepare(`
    INSERT INTO notify_queue (kind, payload, created_at)
    VALUES (?, ?, ?)
  `),
  queuePending: db.prepare(`
    SELECT * FROM notify_queue WHERE sent_at IS NULL ORDER BY id ASC
  `),
  queueMarkSent: db.prepare(`UPDATE notify_queue SET sent_at = ? WHERE id = ?`),
  countByStatusSince: db.prepare(`
    SELECT status, COUNT(*) as n FROM sync_state WHERE updated_at >= ? GROUP BY status
  `),
  failedSince: db.prepare(`
    SELECT * FROM sync_state WHERE status = 'failed' AND updated_at >= ?
  `),
  // 清理"稳定且老"的成功条目：status=ok + hash 自上次起未变 + 已超过 TTL
  // 半填失败的、最近改过的都不清；清理后 zoho_id 会丢，下次需要依赖 field235 兜底反查
  purgeStableOk: db.prepare(`
    DELETE FROM sync_state WHERE status = 'ok' AND updated_at < ?
  `),
  // 拿当前表格不包含的 rowId（本轮 readRows 之外的）做孤儿清理
  listAllRowIds: db.prepare(`SELECT row_id FROM sync_state`),
  deleteByRowId: db.prepare(`DELETE FROM sync_state WHERE row_id = ?`),
  upsertDocid: db.prepare(`
    INSERT INTO wecom_docid (docid, event, op_user, raw, first_seen, last_seen)
    VALUES (@docid, @event, @op_user, @raw, @now, @now)
    ON CONFLICT(docid) DO UPDATE SET
      event     = excluded.event,
      op_user   = excluded.op_user,
      raw       = excluded.raw,
      last_seen = excluded.last_seen
  `),
  listDocids: db.prepare(`SELECT * FROM wecom_docid ORDER BY last_seen DESC`),
  insertCallbackLog: db.prepare(`
    INSERT INTO callback_event_log (event_type, raw, received_at)
    VALUES (?, ?, ?)
  `),
  getConfig: db.prepare(`SELECT value FROM app_config WHERE key = ?`),
  setConfig: db.prepare(`
    INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `),
  listConfig: db.prepare(`SELECT key, value, updated_at FROM app_config ORDER BY key`),
  // 脏标只删 <= snapshot 的，保护"runOnce 跑中途新进来的事件"不被吞
  clearDirtyIfBefore: db.prepare(`
    DELETE FROM app_config
    WHERE key = 'sheet_dirty_since' AND CAST(value AS INTEGER) <= ?
  `),
  // 冷静期 pending 行复查
  hasPendingReady: db.prepare(`
    SELECT 1 FROM sync_state WHERE status='pending' AND last_change_ts <= ? LIMIT 1
  `),
};

function now() {
  return Date.now();
}

module.exports = {
  db,

  getRow(rowId) {
    return stmts.getByRow.get(rowId);
  },

  deleteRow(rowId) {
    stmts.deleteByRowId.run(rowId);
  },

  findFileNo(fileNo) {
    return stmts.findByFileNo.get(fileNo);
  },

  upsert(state) {
    stmts.upsert.run({
      row_id: state.row_id,
      business_key: state.business_key || null,
      zoho_id: state.zoho_id || null,
      status: state.status,
      last_error: state.last_error || null,
      attempts: state.attempts || 0,
      payload_hash: state.payload_hash || null,
      file_no: state.file_no || null,
      now: now(),
    });
  },

  // 冷静期：只登记本次检测到的 hash 和时间，不改 status/zoho_id/last_error
  // 用于"还在录入中"的行，让下一个 tick 能据此判断是否过了冷静期
  touchChange({ row_id, business_key, payload_hash }) {
    stmts.touchChange.run({
      row_id,
      business_key: business_key || null,
      payload_hash: payload_hash || null,
      now: now(),
    });
  },

  enqueueNotify(kind, payload) {
    stmts.queueInsert.run(kind, JSON.stringify(payload), now());
  },

  pendingNotifies() {
    return stmts.queuePending.all().map((r) => {
      try {
        return { ...r, payload: JSON.parse(r.payload) };
      } catch (e) {
        logger.error("notify_queue 记录 %d payload 解析失败: %s", r.id, e.message);
        // 返回安全的默认值，避免整个队列处理失败
        return {
          ...r,
          payload: {
            rowIndex: "-",
            orderConfirmNo: "解析失败",
            errors: [{ field: "系统", reason: "通知数据损坏" }],
          },
        };
      }
    });
  },

  markNotifySent(id) {
    stmts.queueMarkSent.run(now(), id);
  },

  statsSince(sinceTs) {
    const rows = stmts.countByStatusSince.all(sinceTs);
    const out = { ok: 0, failed: 0, pending: 0 };
    for (const r of rows) out[r.status] = r.n;
    return out;
  },

  failedSince(sinceTs) {
    return stmts.failedSince.all(sinceTs);
  },

  /**
   * 清理超过 ttlMs 没动过的"已成功"行的 state。
   * 目的：让 sync_state 不会无限膨胀，超过 TTL 的稳定订单不再追踪修改。
   * 副作用：被清理的行如果用户之后又改了企微表，会被当成新行 → 走 field235 反查兜底避免重复。
   * 返回：实际删除的条目数
   */
  purgeStableOk(ttlMs) {
    const cutoff = now() - ttlMs;
    const r = stmts.purgeStableOk.run(cutoff);
    return r.changes;
  },

  /**
   * 清理"孤儿" state：企微当前表格里不存在的 rowId。
   * 分场景策略：
   *   - status=failed 且企微已删 → 立即删（失败孤儿无追溯价值）
   *   - status=ok    且企微已删 → 保留 ttlMs（默认 7 天），过期才删
   *     目的：万一同事手滑删了已同步行，7 天内还能从 DB 查 zoho_id 追溯到 ZOHO 哪条记录
   *   - status=ok/failed 且企微还在 → 不动（同事可能在跨天继续补录）
   * @param {Set<string>} currentRowIds  本轮 readRows 返回的所有 rowId
   * @param {number} ttlMs               ok 孤儿的保留期，默认 7 天
   * @returns {{purgedFailed:number, purgedOk:number}}
   */
  purgeOrphans(currentRowIds, ttlMs = 7 * 24 * 3600 * 1000) {
    const all = stmts.listAllRowIds.all();
    const cutoff = now() - ttlMs;
    let purgedFailed = 0;
    let purgedOk = 0;
    const tx = db.transaction((ids) => {
      for (const { row_id } of ids) {
        if (currentRowIds.has(row_id)) continue;  // 企微还在 → 跳过
        const rec = stmts.getByRow.get(row_id);
        if (!rec) continue;
        if (rec.status === "failed") {
          stmts.deleteByRowId.run(row_id);
          purgedFailed++;
        } else if (rec.status === "ok" && rec.updated_at < cutoff) {
          stmts.deleteByRowId.run(row_id);
          purgedOk++;
        }
      }
    });
    tx(all);
    return { purgedFailed, purgedOk };
  },

  upsertDocid({ docid, event, op_user, raw }) {
    stmts.upsertDocid.run({ docid, event, op_user, raw, now: now() });
  },

  listDocids() {
    return stmts.listDocids.all();
  },

  logCallbackEvent(event) {
    stmts.insertCallbackLog.run(
      event.Event || event.EventType || null,
      JSON.stringify(event),
      now()
    );
  },

  /**
   * 运行时配置（存 app_config 表）。
   * DB 优先 → 未设置回 null，调用方再 fall back .env。
   */
  getConfig(key) {
    const r = stmts.getConfig.get(key);
    return r ? r.value : null;
  },
  setConfig(key, value) {
    stmts.setConfig.run(key, String(value), now());
  },
  listConfig() {
    return stmts.listConfig.all();
  },

  // ---------- 扫描触发：webhook 标脏 + cron 消费 ----------
  // 模型：webhook 收到"我们 docid 的文档变更" → markSheetDirty(now)
  //       cron tick → getSheetDirtySince：有值 → snapshot = now(); runOnce; clearSheetDirty(snapshot)
  //       若 runOnce 跑中途有新事件，markSheetDirty 用更大时间戳覆盖；
  //       clearSheetDirty 只删 <= snapshot，新事件不被吞 → 下一 tick 还会跑。
  markSheetDirty(ts) {
    stmts.setConfig.run("sheet_dirty_since", String(ts || now()), now());
  },
  getSheetDirtySince() {
    const r = stmts.getConfig.get("sheet_dirty_since");
    if (!r) return null;
    const n = parseInt(r.value, 10);
    return Number.isFinite(n) ? n : null;
  },
  clearSheetDirty(snapshot) {
    stmts.clearDirtyIfBefore.run(snapshot);
  },

  // ---------- runOnce 心跳（webhook 挂掉兜底）----------
  markRunOnceTs(ts) {
    stmts.setConfig.run("last_run_at", String(ts || now()), now());
  },
  getLastRunAt() {
    const r = stmts.getConfig.get("last_run_at");
    if (!r) return null;
    const n = parseInt(r.value, 10);
    return Number.isFinite(n) ? n : null;
  },

  // ---------- 冷静期 pending 行复查 ----------
  // 场景：新行/改过的行进冷静期 → status=pending；之后 webhook 不再推 → 脏标空
  //      → cron 看不到信号 → pending 行永远卡死
  // 兜底：tick 时如果有 pending 且 last_change_ts 已超 cooldown，强制跑一轮
  hasPendingReady(cooldownMs) {
    const cutoff = now() - cooldownMs;
    const r = stmts.hasPendingReady.get(cutoff);
    return !!r;
  },
};
