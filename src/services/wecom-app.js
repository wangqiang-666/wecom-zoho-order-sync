/**
 * 企业微信自建应用「小智」消息推送
 *
 * 用途：ZOHO 同步成功/失败后推送给应用可见范围内的成员
 * API 文档：https://developer.work.weixin.qq.com/document/path/90236
 */

const config = require("../config");
const logger = require("../utils/logger");

let cachedToken = null;
let expiresAt = 0;
let refreshPromise = null;

async function getAccessToken() {
  if (cachedToken && Date.now() < expiresAt) return cachedToken;
  // 并发去抖：避免多个并发调用同时触发 token 刷新
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${config.wecom.corpId}&corpsecret=${config.wecom.agentSecret}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.errcode !== 0) {
      throw new Error(`企微 token 获取失败: ${data.errmsg}`);
    }
    cachedToken = data.access_token;
    expiresAt = Date.now() + Math.max(0, data.expires_in - 300) * 1000;
    logger.info("企微 access_token 已刷新");
    return cachedToken;
  })().finally(() => { refreshPromise = null; });

  return refreshPromise;
}

/**
 * 发送 markdown 消息给所有可见范围内的成员
 * toUser: 指定用户，默认读 config.wecom.notifyTo，传 "@all" 给所有人
 */
async function sendMarkdown(markdown, { toUser } = {}) {
  const token = await getAccessToken();
  const payload = {
    touser: toUser || config.wecom.notifyTo,
    msgtype: "markdown",
    agentid: config.wecom.agentId,
    markdown: { content: markdown },
  };
  const res = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );
  const data = await res.json();
  if (data.errcode !== 0) {
    throw new Error(`企微消息推送失败: ${data.errmsg}`);
  }
  logger.debug("企微消息已推送: %s", markdown.slice(0, 80));
}

/** 单条失败通知 */
async function notifySyncFail({ rowIndex, orderConfirmNo, errors }) {
  const lines = errors.map((e) => `> - **${e.field}**: ${e.reason}`).join("\n");
  const md = [
    `## ❌ 订单同步失败`,
    `**第 ${rowIndex} 行** ｜ 订单确认编号: ${orderConfirmNo || "（空）"}`,
    ``,
    `**失败原因：**`,
    lines,
    ``,
    `请到企微表格修正后，系统会自动重试。`,
  ].join("\n");
  await sendMarkdown(md);
}

/** 每日汇总 */
async function notifyDaily({ date, total, success, failed, failItems }) {
  const failDetail = failItems.length
    ? "\n\n**失败明细：**\n" +
      failItems.slice(0, 20).map((f) =>
        `> - 行${f.rowIndex} ${f.orderConfirmNo || ""}: ${f.reason}`
      ).join("\n")
    : "";
  const md = [
    `## 📊 订单同步日报 (${date})`,
    `- 总处理: **${total}**`,
    `- ✅ 成功: **${success}**`,
    `- ❌ 失败: **${failed}**`,
    failDetail,
  ].join("\n");
  await sendMarkdown(md);
}

module.exports = { sendMarkdown, notifySyncFail, notifyDaily };
