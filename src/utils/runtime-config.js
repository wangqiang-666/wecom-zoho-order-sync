/**
 * 运行时配置读取器
 *
 * 优先级：DB app_config > .env (config.js) > 内置默认
 * 所有对外暴露的 getter 都是实时读 DB，Web UI 改了立刻生效。
 *
 * 管理的 key：
 *   - sheet_prefix              子表前缀，默认 CS_
 *   - sheet_excludes            黑名单 CSV，永久 union 默认 ["CS_IT"]
 *   - poll_interval_sec         轮询间隔秒数，覆盖 .env 的分钟值
 */

const config = require("../config");
const db = require("./db");
const logger = require("./logger");

function getSheetPrefix() {
  return db.getConfig("sheet_prefix") || config.sheets.prefix;
}

/**
 * 返回 { prefix, excludes }
 *   - 监听规则：所有 prefix 开头子表 - excludes = 实际监听集
 *   - excludes 永久 union 默认 CS_IT（不依赖首次写入时机，避免漏防护）
 */
const DEFAULT_EXCLUDES = ["CS_IT"];
function getSheetFilter() {
  const excRaw = db.getConfig("sheet_excludes");
  const userExc = String(excRaw ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  // 永久 union 默认黑名单
  const excludes = Array.from(new Set([...DEFAULT_EXCLUDES, ...userExc]));
  return { prefix: getSheetPrefix(), excludes };
}

/**
 * 单表切换：
 *   enabled=true  → 从 excludes 移除（默认黑名单 CS_IT 也允许覆盖，但需用户显式操作）
 *   enabled=false → 加入 excludes
 * 调用方需在改完后强制 invalidateMeta + initMeta，保证下一轮 + 当前 UI 都用新值
 */
function toggleSheet(title, enabled) {
  const t = String(title || "").trim();
  if (!t) throw new Error("sheet title 必填");
  const { excludes } = getSheetFilter();
  let newExc = excludes.slice();
  if (enabled) {
    newExc = newExc.filter((x) => x !== t);
  } else {
    if (!newExc.includes(t)) newExc.push(t);
  }
  // 存储时不写默认黑名单（getSheetFilter 会兜底 union 回来）
  // 这样用户清空配置/换部署时仍有 CS_IT 保护
  const toStore = newExc.filter((x) => !DEFAULT_EXCLUDES.includes(x));
  db.setConfig("sheet_excludes", toStore.join(","));
  return { excludes: newExc };
}

/**
 * 轮询间隔（秒）。DB 优先；否则默认 60 秒（cron 每分钟 tick 一次）。
 * 配合单行冷静期使用：巡逻勤快，但每行有 2 分钟"别打扰我录入"保护。
 * 最小 30 秒防滥用。
 */
function getPollIntervalSec() {
  const raw = db.getConfig("poll_interval_sec");
  let sec;
  if (raw !== null && !Number.isNaN(Number(raw))) {
    sec = Number(raw);
  } else {
    sec = 60;  // 默认 60 秒（.env 的 POLL_INTERVAL_MINUTES 已废弃）
  }
  return Math.max(30, Math.floor(sec));
}

function setPollIntervalSec(sec) {
  const n = Math.max(30, Math.floor(Number(sec)));
  if (!Number.isFinite(n)) throw new Error("poll_interval_sec 非法");
  db.setConfig("poll_interval_sec", String(n));
  return n;
}

function setSheetPrefix(prefix) {
  db.setConfig("sheet_prefix", String(prefix || "CS_"));
}

/**
 * 单行冷静期（秒）。
 *   - 行的 hash 一变 → 记 last_change_ts，距上次变化 < cooldown 不处理
 *   - 给同事录入留缓冲（避免填一半就被校验/同步打扰）
 *   - 默认 120 秒（2 分钟），最小 0（=关闭，立即处理）
 */
function getRowCooldownSec() {
  const raw = db.getConfig("row_cooldown_sec");
  if (raw === null || Number.isNaN(Number(raw))) return 120;
  return Math.max(0, Math.floor(Number(raw)));
}
function setRowCooldownSec(sec) {
  const n = Math.max(0, Math.floor(Number(sec)));
  if (!Number.isFinite(n)) throw new Error("row_cooldown_sec 非法");
  db.setConfig("row_cooldown_sec", String(n));
  return n;
}

/**
 * 微信通知总开关。
 * DB key: notify_enabled。值 "1"/"true" → 开；其他 → 关。
 * 默认 **关**（用户要求新部署不打扰群）。
 * 关闭时：notify-job 会消费 fail 队列但不实际发，日报也跳过。
 */
function isNotifyEnabled() {
  const v = db.getConfig("notify_enabled");
  if (v === null) return false;        // 未设置 → 默认关
  return v === "1" || v === "true";
}
function setNotifyEnabled(on) {
  db.setConfig("notify_enabled", on ? "1" : "0");
  return !!on;
}

/**
 * 必填字段 override（JSON array of source names）。
 * DB key: required_fields_override。
 * 未设置 → 返回 null → 回落到 field-map.json 的 spec.required 默认值。
 * 设置后 → 返回 string[]，校验层会 union locked 集。
 */
function getRequiredFieldsOverride() {
  const raw = db.getConfig("required_fields_override");
  if (raw === null || raw === "null") return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      logger.warn("required_fields_override 不是数组，回落默认: %s", raw);
      return null;
    }
    return parsed.filter((x) => typeof x === "string");
  } catch (e) {
    logger.warn("required_fields_override JSON 解析失败，回落默认: %s", e.message);
    return null;
  }
}

function setRequiredFieldsOverride(sources) {
  const locked = config.getLockedRequiredSources();
  const allSpecs = config.getAllFieldSpecs();
  const validSources = new Set(allSpecs.map((s) => s.source));
  const input = Array.isArray(sources) ? sources : [];

  // 过滤掉不存在的源字段 + 强制 union locked
  const cleaned = Array.from(
    new Set([
      ...locked,
      ...input.filter((s) => validSources.has(s)),
    ])
  ).sort();

  db.setConfig("required_fields_override", JSON.stringify(cleaned));
  return cleaned;
}

function resetRequiredFieldsOverride() {
  db.setConfig("required_fields_override", "null");
}

module.exports = {
  getSheetPrefix,
  getSheetFilter,
  getPollIntervalSec,
  setPollIntervalSec,
  setSheetPrefix,
  toggleSheet,
  isNotifyEnabled,
  setNotifyEnabled,
  getRequiredFieldsOverride,
  setRequiredFieldsOverride,
  resetRequiredFieldsOverride,
  getRowCooldownSec,
  setRowCooldownSec,
};
