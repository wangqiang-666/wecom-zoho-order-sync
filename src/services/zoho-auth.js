/**
 * ZOHO OAuth Token 管理
 * 直接复用 digital-employee-order-broadcaster 的实现
 */
const config = require("../config");
const logger = require("../utils/logger");

let cached = null;
let expiresAt = 0;
let refreshPromise = null;

async function refresh() {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: config.zoho.clientId,
    client_secret: config.zoho.clientSecret,
    refresh_token: config.zoho.refreshToken,
  });
  const res = await fetch(`${config.zoho.accountsUrl}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await res.json();
  if (data.error) throw new Error(`ZOHO token 续期失败: ${data.error}`);
  if (!data.access_token) throw new Error(`未返回 access_token: ${JSON.stringify(data)}`);

  cached = data.access_token;
  expiresAt = Date.now() + ((data.expires_in || 3600) - 300) * 1000;
  logger.info("ZOHO access_token 已刷新");
  return cached;
}

async function getAccessToken() {
  if (cached && Date.now() < expiresAt) return cached;
  // 并发去抖：如果已经有一个 refresh 在飞，所有并发调用复用同一个 Promise
  // 避免同时触发多次 refresh_token 调用（ZOHO 会限流/旧 token 被吊销）
  if (refreshPromise) return refreshPromise;
  refreshPromise = refresh().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

module.exports = { getAccessToken };
