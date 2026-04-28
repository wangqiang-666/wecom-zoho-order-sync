/**
 * 文件编号生成器
 *
 * 新规则：IN/NP/<客户编号>/<A-Z + 4位数字>/<年>
 *   - 例：IN/NP/12421/A0001/2026
 *   - 全局按年递增：A0001..A9999 -> B0001..Z9999
 *   - A0001 = 1, A9999 = 9999, B0001 = 10000, ... , Z9999 = 259974
 *
 * 设计原则：
 *   1. 本地 SQLite counter 是快路径（性能缓存）
 *   2. 本地 counter 丢失时，可从 ZOHO 最近记录中恢复当前年的最大新规则序号
 *   3. 只识别新规则号段（A0001..Z9999）；旧纯数字/旧随机/杂乱值全部忽略
 *   4. 不再使用 TMP 兜底；查不到客户编号直接抛错
 */

const config = require("../config");
const db = require("./db");
const logger = require("./logger");

const PREFIX = "IN/NP";
const BAND_START = "A".charCodeAt(0);
const BAND_END = "Z".charCodeAt(0);
const BAND_COUNT = BAND_END - BAND_START + 1; // 26
const BAND_SIZE = 9999;
const MAX_SEQ = BAND_COUNT * BAND_SIZE; // 259,974
const RECOVERY_WINDOWS = [100, 300, 500];

function extractCustomerCode(field62) {
  if (!field62) return null;
  const m = String(field62).match(/\d+/);
  return m ? m[0] : null;
}

function formatBandSeq(seq) {
  if (!Number.isInteger(seq) || seq < 1 || seq > MAX_SEQ) {
    throw new Error(`文件编号序号越界: ${seq}，允许范围 1..${MAX_SEQ}`);
  }
  const bandIndex = Math.floor((seq - 1) / BAND_SIZE);
  const band = String.fromCharCode(BAND_START + bandIndex);
  const num = ((seq - 1) % BAND_SIZE) + 1;
  return `${band}${String(num).padStart(4, "0")}`;
}

function parseBandSeq(segment) {
  const m = String(segment || "").match(/^([A-Z])(\d{4})$/);
  if (!m) return null;
  const band = m[1];
  const num = parseInt(m[2], 10);
  const bandIndex = band.charCodeAt(0) - BAND_START;
  if (bandIndex < 0 || bandIndex >= BAND_COUNT) return null;
  if (num < 1 || num > BAND_SIZE) return null;
  return {
    band,
    num,
    seq: bandIndex * BAND_SIZE + num,
  };
}

function parseNewRuleFileNo(fileNo, year) {
  const m = String(fileNo || "").match(new RegExp(`^IN/NP/[^/]+/([A-Z]\\d{4})/${year}$`));
  if (!m) return null;
  const parsed = parseBandSeq(m[1]);
  if (!parsed) return null;
  return { fileNo, segment: m[1], ...parsed };
}

function normalizeZohoRowsToArray(resp) {
  if (!resp) return [];
  if (Array.isArray(resp.data)) return resp.data;
  return [];
}

async function recoverYearMaxSeqFromZoho({ zohoFetch, year }) {
  const moduleApiName = config.zoho.moduleApiName;
  let best = null;

  for (const windowSize of RECOVERY_WINDOWS) {
    let scanned = 0;
    let page = 1;
    let pageBest = null;
    while (scanned < windowSize) {
      const perPage = Math.min(100, windowSize - scanned);
      const resp = await zohoFetch(`/${moduleApiName}?page=${page}&per_page=${perPage}&sort_by=Created_Time&sort_order=desc`);
      const rows = normalizeZohoRowsToArray(resp);
      if (!rows.length) break;
      scanned += rows.length;
      for (const row of rows) {
        const parsed = parseNewRuleFileNo(row.field73, year);
        if (!parsed) continue;
        if (!pageBest || parsed.seq > pageBest.seq) pageBest = parsed;
      }
      if (rows.length < perPage) break;
      page += 1;
    }
    if (pageBest) {
      best = pageBest;
      logger.info("📄 从 ZOHO 恢复计数器：year=%d recent=%d max=%s seq=%d", year, windowSize, pageBest.segment, pageBest.seq);
      break;
    }
  }

  if (!best) {
    logger.info("📄 ZOHO 近期记录中未发现 year=%d 的新规则编号，将从 A0001 开始", year);
    return 0;
  }
  return best.seq;
}

async function resolveCustomerCode({ customerName, zohoFetch, customerCodeCache }) {
  if (!customerName) throw new Error("generateForCustomer: 缺少 customerName");
  if (typeof zohoFetch !== "function") throw new Error("generateForCustomer: 缺少 zohoFetch");

  if (customerCodeCache && customerCodeCache.has(customerName)) {
    const cached = customerCodeCache.get(customerName);
    if (cached.error) throw new Error(cached.error);
    return cached;
  }

  // ZOHO criteria 里 ( ) , 是保留字符，公司名带括号必须用反斜杠转义
  const escaped = String(customerName).replace(/[()]/g, "\\$&");
  const criteria = encodeURIComponent(`(Account_Name:equals:${escaped})`);

  let code = null;
  let accountId = null;
  try {
    const resp = await zohoFetch(`/Accounts/search?criteria=${criteria}`);
    const rec = resp && resp.data && resp.data[0];
    if (rec) {
      code = extractCustomerCode(rec.field62);
      accountId = rec.id || null;
    }
  } catch (e) {
    const msg = `无法生成文件编号：查询 ZOHO Accounts 失败（${customerName}）: ${e.message}`;
    if (customerCodeCache) customerCodeCache.set(customerName, { error: msg });
    throw new Error(msg);
  }

  if (!code) {
    const msg = `无法生成文件编号：渠道名称「${customerName}」未找到客户编号（Accounts.field62）`;
    if (customerCodeCache) customerCodeCache.set(customerName, { error: msg });
    throw new Error(msg);
  }

  const out = { customerCode: code, accountId };
  if (customerCodeCache) customerCodeCache.set(customerName, out);
  return out;
}

/**
 * 给指定渠道客户生成一条文件编号。
 *
 * @param {object} opts
 * @param {string} opts.customerName
 * @param {function} opts.zohoFetch
 * @param {function} opts.isFileNoUsed
 * @param {function} opts.markUsed
 * @param {Map} [opts.customerCodeCache]
 * @param {boolean} [opts.dryRun]
 * @param {Date} [opts.now]
 * @returns {Promise<{fileNo:string, customerCode:string, accountId:string|null, seq:number, segment:string}>}
 */
async function generateForCustomer({
  customerName,
  zohoFetch,
  isFileNoUsed,
  markUsed,
  customerCodeCache,
  dryRun = false,
  now = new Date(),
}) {
  if (typeof isFileNoUsed !== "function") throw new Error("generateForCustomer: 缺少 isFileNoUsed");
  if (typeof markUsed !== "function") throw new Error("generateForCustomer: 缺少 markUsed");

  const { customerCode, accountId } = await resolveCustomerCode({ customerName, zohoFetch, customerCodeCache });
  const year = now.getFullYear();

  let counter = db.getFileNoCounter(year);
  let recoverySeed = null;
  if (!counter) {
    recoverySeed = await recoverYearMaxSeqFromZoho({ zohoFetch, year });
    if (!dryRun) {
      counter = db.seedFileNoCounter(year, recoverySeed, recoverySeed > 0 ? "zoho-rebuild" : "init");
    }
  }

  let baseSeq = counter ? counter.last_seq : (recoverySeed ?? 0);
  let attempts = 0;
  while (attempts < 20) {
    attempts += 1;
    let seq;
    if (dryRun) {
      seq = baseSeq + 1;
      baseSeq = seq;
    } else {
      const reserved = db.reserveNextFileNoSeq(year, {
        allowInit: !counter,
        initSeq: recoverySeed ?? 0,
        seedSource: recoverySeed && recoverySeed > 0 ? "zoho-rebuild" : "local",
      });
      if (!reserved) {
        throw new Error(`无法预留文件编号：year=${year}`);
      }
      seq = reserved.seq;
      counter = { year, last_seq: seq, seed_source: reserved.seedSource, updated_at: now.getTime() };
    }

    if (seq > MAX_SEQ) {
      throw new Error(`文件编号已用尽：${year} 年最多支持 ${MAX_SEQ} 个自动编号`);
    }

    const segment = formatBandSeq(seq);
    const fileNo = `${PREFIX}/${customerCode}/${segment}/${year}`;
    if (isFileNoUsed(fileNo)) {
      logger.warn("⚠ 生成到已存在的文件编号 %s，继续尝试下一个序号", fileNo);
      continue;
    }
    markUsed(fileNo);
    return { fileNo, customerCode, accountId, seq, segment };
  }

  throw new Error(`重试 ${attempts} 次仍生成不到不冲突文件编号，请检查历史数据与计数器状态`);
}

module.exports = {
  PREFIX,
  BAND_SIZE,
  MAX_SEQ,
  extractCustomerCode,
  formatBandSeq,
  parseBandSeq,
  parseNewRuleFileNo,
  recoverYearMaxSeqFromZoho,
  generateForCustomer,
};
