/**
 * ZOHO CRM 写入：创建订单 + 反查用户ID + 反查 lookup record_id
 *
 * 关键能力：
 *   - createOrder({payload, dryRun}) ：写入或仅校验（dry-run）
 *   - resolveOwnerByEmail(email)     ：邮箱 → user.id
 *   - resolveLookup(moduleApi, name) ：lookup 模块名 → record_id（带缓存）
 */

const config = require("../config");
const logger = require("../utils/logger");
const { getAccessToken } = require("./zoho-auth");

const userCache = new Map();
const lookupCache = new Map(); // key: `${module}::${name}`

async function zohoFetch(pathOrUrl, opts = {}) {
  const token = await getAccessToken();
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `${config.zoho.apiBaseUrl}${pathOrUrl}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`ZOHO 返回非 JSON: HTTP ${res.status}\n${text.slice(0, 500)}`);
  }
  if (!res.ok) {
    throw new Error(`ZOHO HTTP ${res.status}: ${JSON.stringify(body).slice(0, 500)}`);
  }
  return body;
}

async function resolveOwnerByEmail(email) {
  if (!email) throw new Error("ZOHO_DEFAULT_OWNER_EMAIL 未配置");
  if (userCache.has(email)) return userCache.get(email);

  const data = await zohoFetch(`/users?type=AllUsers`);
  const user = (data.users || []).find(
    (u) => u.email?.toLowerCase() === email.toLowerCase()
  );
  if (!user) throw new Error(`ZOHO 找不到用户: ${email}`);
  userCache.set(email, user.id);
  logger.info("ZOHO 用户 %s → id=%s", email, user.id);
  return user.id;
}

// 全体用户缓存：按 full_name / first_name / alias / email 前缀 做模糊匹配
let _allUsersCache = null;
async function getAllUsers() {
  if (_allUsersCache) return _allUsersCache;
  const data = await zohoFetch(`/users?type=AllUsers`);
  _allUsersCache = data.users || [];
  logger.info("ZOHO 全体用户缓存: %d 条", _allUsersCache.length);
  return _allUsersCache;
}

/**
 * 按姓名（表格"订单所有者"列填的中文/英文）反查 ZOHO user.id
 * 匹配顺序（大小写不敏感、去空格）：
 *   1. 仅匹配 active 用户：full_name / first_name / alias / email 前缀
 *   2. 还没匹到 → 放宽到 disabled 用户（同样规则）
 *   3. 还没匹到 → 返回 null（调用方 fallback 到默认 owner）
 */
async function resolveUserByName(name) {
  if (!name) return null;
  const cleaned = String(name).trim().toLowerCase();
  if (!cleaned) return null;
  const cacheKey = `name::${cleaned}`;
  if (userCache.has(cacheKey)) return userCache.get(cacheKey);

  const users = await getAllUsers();
  const norm = (s) => String(s || "").trim().toLowerCase();
  const emailPrefix = (u) => norm(u.email).split("@")[0];

  const match = (user) =>
    norm(user.full_name) === cleaned ||
    norm(user.first_name) === cleaned ||
    norm(user.alias) === cleaned ||
    emailPrefix(user) === cleaned;

  let hit = users.find((u) => u.status === "active" && match(u));
  if (!hit) hit = users.find((u) => match(u)); // 放宽
  const id = hit?.id || null;
  userCache.set(cacheKey, id);
  if (id) {
    logger.info("ZOHO 姓名反查 「%s」 → id=%s (%s, status=%s)", name, id, hit.email, hit.status);
  } else {
    logger.warn("ZOHO 姓名反查 「%s」 未命中任何用户，将使用默认 owner", name);
  }
  return id;
}

/**
 * 通过显示名在 lookup 模块中找 record_id
 * searchField 指定搜索字段（Accounts→Account_Name, Products→Product_Name, 其他默认 Name）
 */
async function resolveLookup(moduleApiName, displayName, searchField = "Name") {
  const key = `${moduleApiName}::${searchField}::${displayName}`;
  if (lookupCache.has(key)) return lookupCache.get(key);

  // ZOHO 搜索 criteria 的特殊字符必须反斜杠转义，否则 HTTP 400 INVALID_QUERY
  // 至少包含: ( ) , : \
  // 参考: https://www.zoho.com/crm/developer/docs/api/v2/search-records.html
  const escapeCriteria = (s) => String(s).replace(/([(),\\:])/g, "\\$1");

  // 三段式查找：
  //   1. equals 精确匹配（最稳）
  //   2. equals 失败（HTTP 400 / 0 条）→ starts_with 取前缀做候选集
  //   3. 候选集里挑跟原名 normalize 后完全一致的那条（去掉空格/全半角符号差异）
  // 这样既容忍 ZOHO 那边历史数据的标点小差，又不会乱挑同前缀的别家公司。
  const tryEquals = async () => {
    const criteria = `(${searchField}:equals:${escapeCriteria(displayName)})`;
    try {
      const data = await zohoFetch(`/${moduleApiName}/search?criteria=${encodeURIComponent(criteria)}`);
      return (data.data || [])[0] || null;
    } catch (e) {
      // 400 → 转义没救，让 fallback 接手；其他错（401/500 等）直接抛
      if (/HTTP 400/.test(e.message)) {
        logger.debug("lookup equals 失败 %s: %s → 走 starts_with fallback", key, e.message);
        return null;
      }
      throw e;
    }
  };

  const normalize = (s) => String(s).replace(/[\s\-－—()（）·.,，。]/g, "").toLowerCase();

  const tryStartsWith = async () => {
    // 取前 6 个字做前缀（避免太短候选爆炸；纯英文名一般也够区分）
    const prefix = displayName.slice(0, Math.min(6, displayName.length));
    const criteria = `(${searchField}:starts_with:${escapeCriteria(prefix)})`;
    let data;
    try {
      data = await zohoFetch(`/${moduleApiName}/search?criteria=${encodeURIComponent(criteria)}`);
    } catch (e) {
      logger.warn("lookup starts_with 也失败 %s: %s", key, e.message);
      return null;
    }
    const list = data.data || [];
    if (!list.length) return null;
    const target = normalize(displayName);
    // normalize 后完全相等的记录优先；找不到才返回 null（不乱挑前缀同名）
    const exact = list.find((r) => normalize(r[searchField]) === target);
    if (!exact) {
      logger.debug("lookup starts_with %s 拿到 %d 候选但无 normalize 精确匹配", key, list.length);
      return null;
    }
    logger.info("lookup 模糊命中 %s → %s (id=%s)", displayName, exact[searchField], exact.id);
    return exact;
  };

  let record = await tryEquals();
  if (!record) record = await tryStartsWith();

  if (!record) {
    lookupCache.set(key, null);
    return null;
  }
  lookupCache.set(key, record.id);
  return record.id;
}

/**
 * 创建订单（仅创建，不更新）
 *
 *   设计原则：企微表格里每行只对应"一次性创建 ZOHO 记录"动作。
 *   - 一旦同步成功（DB 里有 zoho_id），这一行在企微就是"历史档案"，怎么改都不再回写到 ZOHO
 *   - 想改 ZOHO 记录 → 用户去 ZOHO 直接改
 *   - 想新建一条 → 在企微删除旧行 / 同位置改内容重导，由调用方（sync-job）识别为新记录后调用本函数
 *
 *   为什么彻底移除 PUT：
 *   - 企微 record_id 在删除后可能复用，DB 按 row_id 查到旧 zoho_id → PUT 把新内容覆盖到旧 ZOHO 记录上
 *     = 灾难性数据损坏（旧订单被改写、新订单丢失）
 *   - 即使 record_id 不复用，用户在已同步行上改内容然后期望"更新到 ZOHO"也不是我们的设计目标
 *
 *   调用约定：本函数只负责 POST 创建。调用方 sync-job 必须保证：
 *   - DB 里 status=ok + 有 zoho_id 的行，绝对不调用本函数（无论 hash 是否变化）
 *   - hash 变化的已同步行 = "同位置新记录"，调用方先清掉 DB 旧记录再调用本函数
 *
 * payload 是 ZOHO 字段格式 { api_name: value, ... }
 */
async function createOrder({ payload, dryRun = false, wecomRecordId }) {
  if (dryRun) {
    logger.info("[DRY-RUN] 校验通过，模拟写入: %s", JSON.stringify(payload).slice(0, 300));
    return { ok: true, dryRun: true, simulatedId: `DRY-${Date.now()}` };
  }

  const technicalKeyField = config.zoho.technicalKeyFieldApiName;
  // 技术唯一键写入专用字段，方便 ZOHO 端排查（不再用作反查依据）
  if (technicalKeyField && wecomRecordId && payload[technicalKeyField] === undefined) {
    payload[technicalKeyField] = wecomRecordId;
  }

  const body = { data: [payload], trigger: ["workflow"] };
  const result = await zohoFetch(`/${config.zoho.moduleApiName}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const row = result.data?.[0];
  if (!row || row.code !== "SUCCESS") {
    throw new Error(`ZOHO 写入失败: ${JSON.stringify(row || result)}`);
  }
  return { ok: true, id: row.details?.id, raw: row, mode: "create" };
}

module.exports = { createOrder, resolveOwnerByEmail, resolveUserByName, resolveLookup, zohoFetch };
