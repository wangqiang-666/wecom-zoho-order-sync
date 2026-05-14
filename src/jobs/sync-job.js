/**
 * 主同步任务：轮询 → 映射 → 写 ZOHO → 回写企微表格状态 → 入通知队列
 */

const path = require("path");
const fs = require("fs");
const config = require("../config");
const logger = require("../utils/logger");
const db = require("../utils/db");
const sheet = require("../services/wecom-sheet");
const runtimeConfig = require("../utils/runtime-config");
const { transformRow } = require("../mappers/value-transform");
const fileNo = require("../utils/file-no");
const {
  createOrder,
  resolveOwnerByEmail,
  resolveUserByName,
  resolveLookup,
  zohoFetch,
} = require("../services/zoho-write");

let ownerIdCache = null;
// 进程内串行锁：防止同一 Node 进程里 cron + 启动首跑 + 手动触发同时进入 runOnce
// （文件锁是跨进程兜底，进程内锁更快也更可靠）
let _runOncePromise = null;

// 跨进程文件锁：服务进程 + 手动脚本 + 任何并发触发 → 同一时刻只允许一个 runOnce
// ZOHO 沙盒对并发敏感（workflow/autonumber 异步生成，并发会互相干扰）
// 策略：检测到锁就直接放弃返回，不排队（排队会让 cron 堆积、卡 callback）
const LOCK_PATH = path.join(path.dirname(
  path.isAbsolute(config.db.path) ? config.db.path : path.join(__dirname, "..", "..", config.db.path)
), "sync.lock");
const LOCK_STALE_MS = 10 * 60 * 1000; // 10 分钟视为过期锁（崩溃残留）

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function tryAcquireLock() {
  try {
    fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
    // O_EXCL：原子创建，已存在则抛错
    const fd = fs.openSync(LOCK_PATH, "wx");
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  // 锁已存在 → 检查持有者是否还活着 / 是否过期
  try {
    const raw = fs.readFileSync(LOCK_PATH, "utf8");
    const info = JSON.parse(raw);
    const stale = Date.now() - (info.startedAt || 0) > LOCK_STALE_MS;
    const dead = !isPidAlive(info.pid);
    if (stale || dead) {
      logger.warn("⚠ 发现过期/死锁 (pid=%d, age=%dms, alive=%s) 强制清理",
        info.pid, Date.now() - (info.startedAt || 0), !dead);
      fs.unlinkSync(LOCK_PATH);
      return tryAcquireLock(); // 重试一次
    }
    return { heldBy: info };
  } catch (e) {
    // 锁文件破损 → 清掉重建
    logger.warn("⚠ 锁文件破损，清理重建: %s", e.message);
    try { fs.unlinkSync(LOCK_PATH); } catch {}
    return tryAcquireLock();
  }
}

function releaseLock() {
  try {
    const raw = fs.readFileSync(LOCK_PATH, "utf8");
    const info = JSON.parse(raw);
    if (info.pid === process.pid) fs.unlinkSync(LOCK_PATH);
  } catch {}
}

// 进程异常退出时清理自己持有的锁
let _lockCleanupRegistered = false;
function ensureLockCleanupOnExit() {
  if (_lockCleanupRegistered) return;
  _lockCleanupRegistered = true;
  const cleanup = () => releaseLock();
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });
  process.on("uncaughtException", (e) => { logger.error("uncaught: %s", e.stack); cleanup(); process.exit(1); });
}

// 失败计数推进规则（告警疲劳去抖）：
//   - 内容变了（hash 变）→ 视为同事真改了东西重试 → 重置 attempts=1
//   - 内容没变（仅清状态列也不算） → attempts++，达上限后静默
// 前置：hashRow 已排除"导入状态"列，所以程序自己回写状态不会让 hash 抖动
function bumpAttempts(existing, row) {
  if (!existing) return 1;
  if (existing.payload_hash !== row.hash) return 1;  // 内容真变了
  return (existing.attempts || 0) + 1;
}

// 是否还应该入通知队列（达到上限就沉默，避免同一行刷屏）
function shouldNotifyFailure(nextAttempts) {
  return nextAttempts <= config.poll.maxNotifyAttempts;
}

async function ensureOwnerId() {
  if (ownerIdCache) return ownerIdCache;
  if (config.zoho.defaultOwnerId) {
    ownerIdCache = config.zoho.defaultOwnerId;
    logger.info("使用预配置的 Owner user_id: %s", ownerIdCache);
    return ownerIdCache;
  }
  if (!config.zoho.defaultOwnerEmail) {
    throw new Error("ZOHO_DEFAULT_OWNER_EMAIL/ID 都未配置");
  }
  ownerIdCache = await resolveOwnerByEmail(config.zoho.defaultOwnerEmail);
  return ownerIdCache;
}

async function processOne(row, { dryRun, customerCodeCache, inflightFileNos, requiredOverride, lockedSources, cooldownMs }) {
  let existing = db.getRow(row.rowId);

  // 已经在企微侧显示完成的行，一律视为历史记录。
  // 这层保护不依赖本地 SQLite，避免重部署/换库后旧的「导入」触发位再次创建 ZOHO。
  if (isAlreadyImported(row)) {
    logger.info("⏭ 行%d 企微导入状态已完成（%s），跳过创建", row.rowIndex, row.status);
    return { skipped: true, reason: "already imported status" };
  }

  // 录入冷静期：行 hash 跟 DB 不一致 + 距上次变化还不到 cooldown → 视为"还在录入中"
  // 只更新 last_change_ts/hash，不做 ZOHO 写入，也不回写失败状态
  // 好处：同事连续填多个字段不会在每次 tick 就被校验报错打断
  // 例外：hash 跟 existing 相同 → 说明内容没再变，走正常路径（已成功/失败分支各自处理）
  if (cooldownMs > 0 && !isPendingImport(row) && existing && existing.payload_hash !== row.hash) {
    const lastChange = existing.last_change_ts || 0;
    const age = Date.now() - lastChange;
    if (age < cooldownMs) {
      db.touchChange({
        row_id: row.rowId,
        business_key: row.data["订单确认编号"] || null,
        payload_hash: row.hash,
      });
      logger.debug("🧊 行%d 在冷静期内（距上次变化 %ds < %ds），skip",
        row.rowIndex, Math.round(age / 1000), Math.round(cooldownMs / 1000));
      return { skipped: true };
    }
  }
  // 首次见到这一行（DB 无记录）→ 登记 last_change_ts，本轮不处理（等下一 tick 过了冷静期再说）
  if (cooldownMs > 0 && !isPendingImport(row) && !existing) {
    db.touchChange({
      row_id: row.rowId,
      business_key: row.data["订单确认编号"] || null,
      payload_hash: row.hash,
    });
    logger.debug("🧊 行%d 首次出现，进入冷静期 %ds", row.rowIndex, Math.round(cooldownMs / 1000));
    return { skipped: true };
  }
  // ========== 已同步行的处理规则（核心：一旦有 zoho_id，这行就是"历史档案"） ==========

  // 规则 1：已同步 + 内容没变 + 企微状态列还在 → 跳过（什么都不做）
  if (
    existing?.status === "ok" &&
    existing?.zoho_id &&
    existing?.payload_hash === row.hash &&
    row.status // 状态列还在
  ) {
    logger.debug("跳过未修改且已成功的行: %s", row.rowId);
    return { skipped: true };
  }

  // 规则 2：已同步 + 内容没变 + 状态列被清 → 假失败（ZOHO 成功但企微回写失败），仅补回写状态
  if (
    existing?.status === "ok" &&
    existing?.zoho_id &&
    existing?.payload_hash === row.hash &&
    !row.status
  ) {
    if (!dryRun) {
      try {
        await sheet.updateStatus(row.rowId, sheet.STATUS_SUCCESS, existing.zoho_id);
        logger.info("♻ 假失败兜底：行%d ZOHO 已成功(zoho=%s)，补回写状态", row.rowIndex, existing.zoho_id);
      } catch (e) {
        logger.warn("补回写状态失败（不影响 DB ok 状态）: %s", e.message);
      }
    }
    return { ok: true };
  }

  // 规则 3：已同步 + 内容变了 → "同位置新记录"（record_id 复用 / 用户改内容重导）
  //   → 清掉 DB 旧记录，当作全新行 POST 创建
  //   → 旧 ZOHO 记录保持不动（用户想改旧记录去 ZOHO 改）
  if (
    existing?.status === "ok" &&
    existing?.zoho_id &&
    existing?.payload_hash !== row.hash
  ) {
    logger.info("🆕 行%d 内容变化（旧 zoho=%s），识别为同位置新记录，清 DB 旧状态后重新创建",
      row.rowIndex, existing.zoho_id);
    // 清掉 DB 旧记录（让后续逻辑当作首次同步处理）
    db.deleteRow(row.rowId);
    // 重置 existing 为 null，后续走"首次同步"路径
    existing = null;
  }
  // 内容没变 + 上次失败 → 也跳过，避免无意义重试
  // 例外：用户清掉了企微状态列（row.status 为空） → 视为"请求重试"信号，不跳过
  if (
    existing?.payload_hash === row.hash &&
    existing?.status === "failed" &&
    row.status
  ) {
    logger.debug("跳过未修改的失败行: %s", row.rowId);
    return { skipped: true };
  }

  // 给用户明确反馈：系统已经接到这行并开始处理。
  // 注意：这里改为 fire-and-forget，不等"处理中"回写完成 —— 节省 300-500ms。
  // 安全性：updateStatus 内部已串行队列化（按 sheetId），处理中和后续成功/失败的回写
  // 会在企微端按提交顺序执行；本 worker 不阻塞，立刻进入 transform + ZOHO 写入。
  // dryRun 不写表保持不变。
  if (!dryRun && row.status !== sheet.STATUS_PENDING) {
    sheet.updateStatus(row.rowId, sheet.STATUS_PENDING, "处理中").catch((e) => {
      logger.warn("回写导入中状态失败 rowId=%s: %s", row.rowId, e.message);
    });
  }

  // Stage 1: 类型转换 + 校验
  const defaultOwnerId = await ensureOwnerId();
  const result = await transformRow({
    rawRow: row.data,
    fieldMap: config.fieldMap,
    defaultOwnerId,
    currency: config.zoho.defaultCurrency,
    lookupResolver: resolveLookup,
    userResolver: resolveUserByName,
    requiredOverride,
    lockedSources,
  });

  if (!result.ok) {
    const reason = result.errors.map((e) => `${e.field}(${e.reason})`).join(", ");
    const nextAttempts = bumpAttempts(existing, row);
    logger.warn("校验失败 行%d (第%d次): %s", row.rowIndex, nextAttempts, reason);
    db.upsert({
      row_id: row.rowId,
      business_key: row.data["订单确认编号"] || null,
      status: "failed",
      last_error: JSON.stringify(result.errors),
      attempts: nextAttempts,
      payload_hash: row.hash,
    });
    if (shouldNotifyFailure(nextAttempts)) {
      db.enqueueNotify("fail", {
        rowIndex: row.rowIndex,
        orderConfirmNo: row.data["订单确认编号"] || "",
        errors: result.errors,
      });
    } else {
      logger.info("🔕 行%d 已连续失败 %d 次（>= %d），通知静默；同事修改内容后会重置",
        row.rowIndex, nextAttempts, config.poll.maxNotifyAttempts);
    }
    if (!dryRun) await sheet.updateStatus(row.rowId, sheet.STATUS_FAILED, reason.slice(0, 200));
    return { failed: true };
  }

  // Stage 2: 写 ZOHO（仅在真正调 API 时限速）
  let fileNoValue = existing?.file_no;

  // 🛡 防重创建关键兜底：在真正 POST 之前，再读一次 DB 最新状态。
  // 防御场景：runOnce 拿到 row 后到 createOrder 之间，webhook 路径的 processSingleRow
  // 可能已经处理过同一行并落了 ok。如果不重检，这里就会再 POST 一次 → 重复 ZOHO 记录（灾难）。
  // 重检规则：DB 已 ok + zoho_id + hash 一致 → 直接走"仅回写状态"，绝不重复创建。
  const fresh = db.getRow(row.rowId);
  if (fresh?.status === "ok" && fresh.zoho_id && fresh.payload_hash === row.hash) {
    logger.info("🛡 行%d 在并发窗口内已被另一路径同步成功 (zoho=%s)，本次仅回写状态不重复创建",
      row.rowIndex, fresh.zoho_id);
    if (!dryRun) {
      try { await sheet.updateStatus(row.rowId, sheet.STATUS_SUCCESS, fresh.zoho_id); }
      catch (e) { logger.warn("回写已成功状态失败（不影响 DB ok 状态）: %s", e.message); }
    }
    return { ok: true };
  }

  // Stage 2a: 写 ZOHO（独立 try —— 这里失败才算"真失败"）
  let zohoRes;
  try {
    // 文件编号：新建订单时按"渠道客户名"现生成；更新订单沿用 DB 旧值（不换号）
    if (!fileNoValue) {
      const customerName = String(row.data["渠道名称"] || "").trim();
      const gen = await fileNo.generateForCustomer({
        customerName,
        zohoFetch,
        // 并发去重：DB 落盘前的 in-flight 编号也要算"已用"，否则同 worker 池的兄弟可能撞号
        isFileNoUsed: (no) => !!db.findFileNo(no) || (inflightFileNos && inflightFileNos.has(no)),
        markUsed: (no) => { if (inflightFileNos) inflightFileNos.add(no); },
        customerCodeCache,
        dryRun,
      });
      fileNoValue = gen.fileNo;
      // field184: 渠道编号（Accounts.field62 完整原始值，如 A14637）
      // 跟文件编号同源：取自渠道客户的 ZOHO 账号客户编号字段，订单上自动回填
      if (gen.customerCodeRaw) {
        result.payload.field184 = gen.customerCodeRaw;
      }
      logger.info("📄 生成文件编号 行%d 渠道=「%s」 → %s (客户编号=%s)",
        row.rowIndex, customerName, fileNoValue, gen.customerCode);
    }
    result.payload.field73 = fileNoValue;

    zohoRes = await createOrder({
      payload: result.payload,
      dryRun,
      wecomRecordId: row.recordId,
    });
  } catch (e) {
    const reason = e.message;
    const nextAttempts = bumpAttempts(existing, row);
    logger.error("❌ ZOHO 写入失败 行%d (第%d次): %s", row.rowIndex, nextAttempts, reason);
    db.upsert({
      row_id: row.rowId,
      business_key: row.data["订单确认编号"] || null,
      status: "failed",
      last_error: reason,
      attempts: nextAttempts,
      payload_hash: row.hash,
      file_no: fileNoValue,
    });
    if (shouldNotifyFailure(nextAttempts)) {
      db.enqueueNotify("fail", {
        rowIndex: row.rowIndex,
        orderConfirmNo: row.data["订单确认编号"] || "",
        errors: [{ field: "ZOHO写入", reason }],
      });
    } else {
      logger.info("🔕 行%d 已连续失败 %d 次（>= %d），通知静默；同事修改内容后会重置",
        row.rowIndex, nextAttempts, config.poll.maxNotifyAttempts);
    }
    if (!dryRun) {
      try { await sheet.updateStatus(row.rowId, sheet.STATUS_FAILED, `ZOHO写入(${reason.slice(0, 150)})`); }
      catch (e2) { logger.warn("回写失败状态也失败（不影响 DB）: %s", e2.message); }
    }
    return { failed: true };
  }

  // Stage 2b: ZOHO 已成功 → 立刻落 DB ok（必须先于回写企微，绝不能因为企微回写失败把 ok 覆盖成 failed）
  // 这是"一行=一条 ZOHO"铁律的关键：一旦 ZOHO POST 成功返回 id，DB 必须立即记录，
  // 这样下一轮 sync / 并发的 processSingleRow 重检都会看到 ok，不会再次创建。
  db.upsert({
    row_id: row.rowId,
    business_key: row.data["订单确认编号"] || null,
    zoho_id: zohoRes.id || zohoRes.simulatedId,
    status: "ok",
    last_error: null,
    attempts: (existing?.attempts || 0) + 1,
    payload_hash: row.hash,
    file_no: fileNoValue,
  });

  // Stage 2c: 回写企微"导入状态"列 —— 失败只 warn，DB 仍是 ok
  // 下一轮 sync 会发现"DB ok + 状态列被清/为空"，自动走"仅回写"分支补上（规则 2）
  if (!dryRun) {
    try {
      await sheet.updateStatus(row.rowId, sheet.STATUS_SUCCESS, zohoRes.id);
    } catch (e) {
      logger.warn("⚠ 行%d ZOHO 已成功(zoho=%s) 但企微状态回写失败: %s — 下一轮会自动补回写，不会重复创建",
        row.rowIndex, zohoRes.id, e.message);
    }
  }
  logger.info("✅ 同步创建 行%d → zoho_id=%s", row.rowIndex, zohoRes.id || zohoRes.simulatedId);
  return { ok: true };
}

async function runOnce({ dryRun = false } = {}) {
  // 进程内串行：已有 runOnce 在跑就直接返回 in-flight 标识（不复用 Promise 也不排队）
  // 关键：调用方（tickSync）必须根据这个标识决定要不要 clearSheetDirty——
  //   如果复用了进行中的 Promise，那 runOnce 早就读完表了，本 tick 期间到达的脏标
  //   并没有被处理；这时若 clearSheetDirty(now) 会把新事件吞掉 → 漏单。
  if (_runOncePromise) {
    logger.debug("runOnce 已在进程内运行，本次触发跳过（避免吞掉新脏标）");
    return { skipped: true, reason: "in-flight" };
  }
  _runOncePromise = _runOnceInternal({ dryRun }).finally(() => {
    _runOncePromise = null;
  });
  return _runOncePromise;
}

function isPendingImport(row) {
  return String(row.data["是否确定导入"] || "").trim() === "导入";
}

function isAlreadyImported(row) {
  const status = String(row.status || "").trim();
  // 仅拦截"明确成功"的状态，不拦截"导入中"/"导入失败"
  // 理由：
  //   - "导入中"：可能是上次崩溃残留，必须允许重试，否则用户无法恢复
  //   - "导入失败: xxx"：用户改内容后会自动重试，是核心功能不能拦
  //   - 只看"导入成功"前缀 + "已导入"：这两个表示 ZOHO 一定已存在记录
  if (status === "已导入") return true;
  if (status.startsWith(sheet.STATUS_SUCCESS)) return true;  // "导入成功" / "导入成功 (zoho=xxx)"
  return false;
}

async function processRows(rows, { dryRun = false, onlyPendingImport = false, cooldownMs = 0 } = {}) {
  const requiredOverride = runtimeConfig.getRequiredFieldsOverride();
  const lockedSources = config.getLockedRequiredSources();
  const stats = { total: rows.length, ok: 0, failed: 0, skipped: 0 };

  // 测试白名单：SYNC_ORDER_NO_WHITELIST_PREFIX=TEST- 时，仅处理订单确认编号以该前缀开头的行
  const whitelistPrefix = process.env.SYNC_ORDER_NO_WHITELIST_PREFIX || "";
  let filteredRows = onlyPendingImport
    ? rows.filter((r) => isPendingImport(r) && !isAlreadyImported(r))
    : rows;
  stats.total = filteredRows.length;
  if (whitelistPrefix) {
    const before = filteredRows.length;
    filteredRows = filteredRows.filter((r) => {
      const no = String(r.data["订单确认编号"] || "").trim();
      return no.startsWith(whitelistPrefix);
    });
    logger.warn("⚠ 白名单模式: 仅处理订单确认编号以「%s」开头的行, %d/%d 命中",
      whitelistPrefix, filteredRows.length, before);
    stats.total = filteredRows.length;
    stats.whitelistSkipped = before - filteredRows.length;
  }

  // 跨子表订单确认编号冲突检测：所有入口统一执行，避免 webhook/admin 绕过 runOnce 的保护。
  const byOrderNo = new Map();
  for (const r of filteredRows) {
    const no = String(r.data["订单确认编号"] || "").trim();
    if (!no) continue;
    if (!byOrderNo.has(no)) byOrderNo.set(no, []);
    byOrderNo.get(no).push(r);
  }
  const conflictRowIds = new Set();
  for (const [no, group] of byOrderNo.entries()) {
    if (group.length <= 1) continue;
    if (cooldownMs > 0) {
      const someoneTyping = group.some((g) => {
        const ex = db.getRow(g.rowId);
        const lastChange = ex?.last_change_ts || 0;
        return lastChange > 0 && (Date.now() - lastChange) < cooldownMs;
      });
      if (someoneTyping) {
        logger.info("🧊 订单号「%s」涉及 %d 行疑似冲突，但组内有人在冷静期内，本轮跳过裁决",
          no, group.length);
        continue;
      }
    }
    const sheets = [...new Set(group.map((g) => g.sheetTitle || "?"))];
    const detail = `订单确认编号「${no}」在多个子表重复: ${sheets.join("/")}`;

    // 防御：如果组内有行已经成功同步（DB ok + zoho_id + hash 未变），
    // 说明这行已经是"历史档案"（规则3之前的状态），不该把它标成失败。
    // 只把"未同步/内容变了的新行"之间的冲突标失败。
    const pending = group.filter((g) => {
      const ex = db.getRow(g.rowId);
      // 已同步且内容没变 → 这是历史档案，跳过冲突判定
      return !(ex?.status === "ok" && ex?.zoho_id && ex?.payload_hash === g.hash);
    });
    if (pending.length <= 1) {
      // 只有 0 或 1 个"新"行参与冲突 → 没有真冲突（历史档案不算）
      logger.info("订单号「%s」组内 %d 行中只有 %d 行待同步，不视为冲突",
        no, group.length, pending.length);
      continue;
    }

    logger.warn("⚠ %s — 该编号涉及 %d 行待同步将全部标失败（跳过 %d 行已同步历史档案）",
      detail, pending.length, group.length - pending.length);
    let maxAttemptsInGroup = 0;
    for (const g of pending) {
      conflictRowIds.add(g.rowId);
      const existing = db.getRow(g.rowId);
      const nextAttempts = bumpAttempts(existing, g);
      maxAttemptsInGroup = Math.max(maxAttemptsInGroup, nextAttempts);
      db.upsert({
        row_id: g.rowId,
        business_key: no,
        status: "failed",
        last_error: detail,
        attempts: nextAttempts,
        payload_hash: g.hash,
      });
      if (!dryRun) {
        try {
          await sheet.updateStatus(g.rowId, sheet.STATUS_FAILED, detail.slice(0, 200));
        } catch (e) {
          logger.error("回写冲突状态失败 rowId=%s: %s", g.rowId, e.message);
        }
      }
      stats.failed++;
    }
    try {
      if (shouldNotifyFailure(maxAttemptsInGroup)) {
        db.enqueueNotify("fail", {
          rowIndex: "-",
          orderConfirmNo: no,
          errors: [{ field: "跨子表冲突", reason: detail }],
        });
      } else {
        logger.info("🔕 订单号 %s 已连续冲突失败 %d 次（>= %d），通知静默；同事改号/改内容后会重置",
          no, maxAttemptsInGroup, config.poll.maxNotifyAttempts);
      }
    } catch (e) {
      logger.error("入队冲突通知失败: %s", e.message);
    }
  }

  const todo = filteredRows
    .slice(0, config.poll.maxRows)
    .filter((r) => !conflictRowIds.has(r.rowId));
  const customerCodeCache = new Map();
  const inflightFileNos = new Set();
  const concurrency = Math.min(config.poll.zohoConcurrency, todo.length || 1);
  logger.info("⚡ 并发处理 %d 行，并发度=%d", todo.length, concurrency);

  let cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= todo.length) return;
      const row = todo[idx];
      try {
        const r = await processOne(row, { dryRun, customerCodeCache, inflightFileNos, requiredOverride, lockedSources, cooldownMs });
        if (r.ok) stats.ok++;
        else if (r.failed) stats.failed++;
        else if (r.skipped) stats.skipped++;
      } catch (e) {
        logger.error("worker 兜底捕获 行%d: %s", row.rowIndex, e.stack);
        stats.failed++;
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return stats;
}

async function _runOnceInternal({ dryRun = false } = {}) {
  ensureLockCleanupOnExit();
  const acquired = tryAcquireLock();
  if (acquired !== true) {
    const held = acquired.heldBy;
    logger.info("⏸ 已有 runOnce 在跑 (pid=%d, started %dms 前)，本次触发被跳过",
      held.pid, Date.now() - (held.startedAt || 0));
    return { skipped: true, reason: "locked", heldBy: held };
  }
  const t0 = Date.now();
  const cooldownMs = runtimeConfig.getRowCooldownSec() * 1000;

  try {
    // 每次同步前主动刷一次 Reference 字典（渠道/业务细类等）
    // 保证读出来的行数据用的是企微端最新名字（避免改名后缓存陈旧把新名字解析成旧名字）
    // 失败不阻断同步：refreshAllRefDicts 内部已逐字典 try/catch，失败时保留旧缓存
    try {
      await sheet.refreshAllRefDicts();
    } catch (e) {
      logger.warn("同步前刷新字典失败（保留旧缓存继续）: %s", e.message);
    }

    let rows;
    try {
      rows = await sheet.readRows();
    } catch (e) {
      logger.error("读取企微表格失败: %s", e.message);
      try {
        db.enqueueNotify("fail", {
          rowIndex: "-",
          orderConfirmNo: "读取企微表格失败",
          errors: [{ field: "sheet.readRows", reason: e.message.slice(0, 300) }],
        });
      } catch (dbErr) {
        logger.error("入队通知也失败了: %s", dbErr.message);
      }
      return { error: e.message };
    }

    // 孤儿清理（仅动后端 SQLite，不动企微表格也不动 ZOHO 订单）
    try {
      const currentIds = new Set(rows.map((r) => r.rowId));
      const ttlMs = (Number(process.env.SYNC_STATE_TTL_DAYS) || 7) * 24 * 3600 * 1000;
      const r = db.purgeOrphans(currentIds, ttlMs);
      if (r.purgedFailed || r.purgedOk) {
        logger.info("🧹 清理孤儿 state: failed=%d (立即), ok=%d (超 %d 天)",
          r.purgedFailed, r.purgedOk, ttlMs / 86400000);
      }
    } catch (e) {
      logger.warn("孤儿清理失败（不影响本轮）: %s", e.message);
    }

    const stats = await processRows(rows, { dryRun, cooldownMs });
    logger.info("本轮完成 耗时%dms  %o", Date.now() - t0, stats);
    return stats;
  } finally {
    releaseLock();
  }
}

/**
 * 单行立即处理（webhook 触发）
 *
 * 并发保护：使用与 runOnce/processPendingImports 相同的文件锁。
 *   理由：deleteRow + POST 之间存在并发窗口，若不拿锁，两路同时命中"同位置新记录"
 *   规则会各自 POST 一次 → 两条 ZOHO 记录（违反"一行=一条 ZOHO"铁律）。
 *   牺牲了"立即"的语义（如果其他扫描在跑会被跳过），但保住了同步质量。
 *
 * 不检查 cooldown（用户已明确点击"导入"，不应被冷静期拦截）
 */
async function processSingleRow(rowId, { dryRun = false } = {}) {
  ensureLockCleanupOnExit();
  const acquired = tryAcquireLock();
  if (acquired !== true) {
    const held = acquired.heldBy;
    logger.info("⏸ 单行处理被跳过：已有同步任务在跑 (pid=%d, started %dms 前) — 该行会被即将开始的扫描覆盖到",
      held.pid, Date.now() - (held.startedAt || 0));
    return { skipped: true, reason: "locked", heldBy: held };
  }

  const t0 = Date.now();
  logger.info("🚀 单行立即处理: rowId=%s", rowId);

  // 读取运行时必填字段配置
  const requiredOverride = runtimeConfig.getRequiredFieldsOverride();
  const lockedSources = config.getLockedRequiredSources();
  const cooldownMs = 0; // 单行立即处理，不检查冷静期

  try {
    // 读取企微表格所有行（需要找到对应的 rowId）
    let rows;
    try {
      rows = await sheet.readRows();
    } catch (e) {
      logger.error("读取企微表格失败: %s", e.message);
      return { error: e.message };
    }

    // 找到目标行
    const row = rows.find((r) => r.rowId === rowId);
    if (!row) {
      logger.warn("⚠ 未找到 rowId=%s，可能已被删除", rowId);
      return { error: "row not found" };
    }

    // 🛡 webhook 路径的最前置硬保护：
    // 不管 DB 有没有记录，只要企微表格状态显示已成功/已导入/处理中/含zoho=
    // → 这行的 ZOHO 记录已经存在，绝不能再次 POST
    // 这层保护是防御"重部署/换库后 DB 没记录但企微状态还在"的关键
    if (isAlreadyImported(row)) {
      logger.info("⏭ webhook 行%d 企微状态已完成（%s），跳过创建", row.rowIndex, row.status);
      return { skipped: true, reason: "already imported status" };
    }

    // 已同步行的处理规则（与 processOne 一致）：
    // - 已同步 + 内容没变 → 跳过
    // - 已同步 + 内容变了 → 识别为"同位置新记录"，清 DB 旧记录后重新创建
    const existing = db.getRow(rowId);
    if (existing?.status === "ok" && existing?.zoho_id) {
      if (existing.payload_hash === row.hash) {
        logger.info("⏭ 行%d 已同步且内容未变 (zoho_id=%s)，skip", row.rowIndex, existing.zoho_id);
        return { skipped: true, reason: "already synced unchanged" };
      } else {
        logger.info("🆕 行%d 内容变化（旧 zoho=%s），识别为同位置新记录，清 DB 旧状态后重新创建",
          row.rowIndex, existing.zoho_id);
        db.deleteRow(rowId);
      }
    }

    // 并发控制：单行处理时也需要 inflightFileNos 防止撞号
    const customerCodeCache = new Map();
    const inflightFileNos = new Set();

    // 执行同步
    const result = await processOne(row, {
      dryRun,
      customerCodeCache,
      inflightFileNos,
      requiredOverride,
      lockedSources,
      cooldownMs,
    });

    // 回写"是否确定导入"列
    if (!dryRun) {
      try {
        if (result.ok) {
          // 成功后不清空（企微单选字段不支持清空）
          // 用户需要手动改为其他值才能再次触发
          logger.info("✅ 单行处理成功 rowId=%s 耗时%dms", rowId, Date.now() - t0);
        } else if (result.failed) {
          // 失败时保持"导入"状态，用户可以修改后重试
          logger.warn("❌ 单行处理失败 rowId=%s", rowId);
        }
      } catch (e) {
        logger.error("回写「是否确定导入」失败: %s", e.message);
      }
    }

    return result;
  } catch (e) {
    logger.error("单行处理异常 rowId=%s: %s", rowId, e.stack);
    return { error: e.message };
  } finally {
    releaseLock();
  }
}

async function processPendingImports({ dryRun = false } = {}) {
  // 并发保护：使用与 runOnce 相同的文件锁
  ensureLockCleanupOnExit();
  const acquired = tryAcquireLock();
  if (acquired !== true) {
    const held = acquired.heldBy;
    logger.info("⏸ 已有同步任务在跑 (pid=%d, started %dms 前)，本次待导入扫描被跳过",
      held.pid, Date.now() - (held.startedAt || 0));
    return { skipped: true, reason: "locked", heldBy: held };
  }

  const t0 = Date.now();
  try {
    let rows;
    try {
      rows = await sheet.readRows();
    } catch (e) {
      logger.error("读取企微表格失败: %s", e.message);
      return { error: e.message };
    }
    const stats = await processRows(rows, { dryRun, onlyPendingImport: true, cooldownMs: 0 });
    logger.info("待导入批处理完成 耗时%dms  %o", Date.now() - t0, stats);
    return stats;
  } finally {
    releaseLock();
  }
}

module.exports = { runOnce, processSingleRow, processPendingImports };
