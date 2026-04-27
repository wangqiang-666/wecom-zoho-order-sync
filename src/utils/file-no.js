/**
 * 文件编号生成器
 *
 * 唯一格式：IN/NP/<客户编号>/<5位随机>/<年>
 *   - 客户编号：ZOHO Accounts.field62 提取数字（A12421 → 12421）；查不到 → "TMP"
 *   - 5 位随机：[A-Z0-9] crypto.randomBytes，本地 sync_state.file_no 查重
 *   - 年：当前系统年份
 *
 * 例：IN/NP/12421/KOKK4/2026   /   兜底：IN/NP/TMP/1EBJ4/2026
 */

const crypto = require("crypto");

const PREFIX = "IN/NP";
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const RAND_LEN = 5;
const MAX_RETRY = 50;

function randomSegment() {
  const buf = crypto.randomBytes(RAND_LEN);
  let s = "";
  for (let i = 0; i < RAND_LEN; i++) s += ALPHABET[buf[i] % ALPHABET.length];
  // 防御日志：记录原始字节，方便排查异常
  const logger = require("./logger");
  logger.debug("[randomSegment] buf=%s → result=%s", buf.toString("hex"), s);
  return s;
}

function extractCustomerCode(field62) {
  if (!field62) return null;
  const m = String(field62).match(/\d+/);
  return m ? m[0] : null;
}

/**
 * 给指定渠道客户生成一条文件编号。
 *
 * @param {object} opts
 * @param {string}   opts.customerName   渠道客户名（ZOHO Accounts.Account_Name）
 * @param {function} opts.zohoFetch      复用 zoho-write.zohoFetch
 * @param {function} opts.isFileNoUsed   (fileNo)=>boolean，本地查重
 * @param {function} opts.markUsed       (fileNo)=>void，登记已用
 * @param {Map}      [opts.customerCodeCache] 单轮缓存：customerName -> { customerCode, accountId }
 * @param {Date}     [opts.now]
 * @returns {Promise<{fileNo:string, customerCode:string, accountId:string|null}>}
 */
async function generateForCustomer({
  customerName,
  zohoFetch,
  isFileNoUsed,
  markUsed,
  customerCodeCache,
  now = new Date(),
}) {
  if (!customerName) throw new Error("generateForCustomer: 缺少 customerName");
  if (typeof zohoFetch !== "function") throw new Error("generateForCustomer: 缺少 zohoFetch");
  if (typeof isFileNoUsed !== "function") throw new Error("generateForCustomer: 缺少 isFileNoUsed");
  if (typeof markUsed !== "function") throw new Error("generateForCustomer: 缺少 markUsed");

  // ZOHO criteria 里 ( ) , 是保留字符，公司名带括号必须用反斜杠转义
  const escaped = String(customerName).replace(/[()]/g, "\\$&");
  const criteria = encodeURIComponent(`(Account_Name:equals:${escaped})`);

  let code = null;
  let accountId = null;

  // 单轮缓存：同一客户名只查一次 ZOHO Accounts（同客户多单批量时很有用）
  // 注意：null 也要缓存（说明查过但没找到 → TMP 兜底），避免反复打 ZOHO
  if (customerCodeCache && customerCodeCache.has(customerName)) {
    const cached = customerCodeCache.get(customerName);
    code = cached.customerCode;
    accountId = cached.accountId;
  } else {
    try {
      const resp = await zohoFetch(`/Accounts/search?criteria=${criteria}`);
      const rec = resp && resp.data && resp.data[0];
      if (rec) {
        code = extractCustomerCode(rec.field62);
        accountId = rec.id;
      }
    } catch (e) {
      // ZOHO 接口失败，走 TMP 兜底
    }
    if (customerCodeCache) {
      customerCodeCache.set(customerName, { customerCode: code, accountId });
    }
  }

  if (!code) code = "TMP";

  const year = now.getFullYear();
  for (let i = 0; i < MAX_RETRY; i++) {
    const rand = randomSegment();
    const fileNo = `${PREFIX}/${code}/${rand}/${year}`;
    // 防御：如果 rand 长度异常（!= 5），立刻报警
    if (rand.length !== RAND_LEN) {
      const logger = require("./logger");
      logger.error("🚨 randomSegment 返回异常长度！rand=%s len=%d 期望=%d buf=%s",
        rand, rand.length, RAND_LEN, require("crypto").randomBytes(RAND_LEN).toString("hex"));
      throw new Error(`randomSegment 异常：生成了 ${rand.length} 位「${rand}」而非 ${RAND_LEN} 位`);
    }
    if (isFileNoUsed(fileNo)) continue;
    markUsed(fileNo);
    return { fileNo, customerCode: code, accountId };
  }
  throw new Error(`重试 ${MAX_RETRY} 次仍生成不到不冲突随机段，请检查查重函数`);
}

module.exports = { generateForCustomer, extractCustomerCode, PREFIX };
