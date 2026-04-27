/**
 * 企微文档事件回调服务
 *
 * 职责：
 *   1. GET /wecom/callback  —— URL 有效性验证（企微第一次点"保存"时触发）
 *   2. POST /wecom/callback —— 接收文档变更事件，捕获 docid 并落库
 *
 * 官方协议：https://developer.work.weixin.qq.com/document/path/90930
 * 文档事件：https://developer.work.weixin.qq.com/document/path/97833
 */

const http = require("http");
const { URL } = require("url");
const config = require("../config");
const logger = require("../utils/logger");
const db = require("../utils/db");
const { decrypt, verifySignature } = require("./wecom-crypto");

const TOKEN = process.env.WECOM_CALLBACK_TOKEN;
const AES_KEY = process.env.WECOM_CALLBACK_AES_KEY;
const RECEIVE_ID = config.wecom.corpId; // 企业回调 receiveId = corpid
const PORT = Number(process.env.WECOM_CALLBACK_PORT || 8080);
const HOST = process.env.WECOM_CALLBACK_HOST || "127.0.0.1";

// 延迟加载：避免循环依赖
let _sheet = null;
let _syncJob = null;
function getSheet() { if (!_sheet) _sheet = require("./wecom-sheet"); return _sheet; }
function getSyncJob() { if (!_syncJob) _syncJob = require("../jobs/sync-job"); return _syncJob; }

// 防抖 + 立即响应：
//   - 第一个事件来时：等 LEADING_DELAY_MS（很短）就触发一次 → 用户感知"立即响应"
//   - 触发期间又有事件：标记为 dirty，本次扫描完成后再补跑一次（捕获新输入）
//   - 这样做既能合并一次点击产生的 2-3 个事件，又不会让用户等 3 秒
// 为什么不能完全去掉防抖：企微一次"导入"点击会产生 2-3 个事件（实测15:40:40/43/48），
// 立即触发会导致 readRows 跑 3 遍浪费资源
const LEADING_DELAY_MS = 600;   // 首次事件后 600ms 触发（足够合并紧密的连发事件）
const TAIL_RESCAN_MS = 2000;    // 上次扫描完成后 2 秒内若有新事件，补扫一次

let _scanTimer = null;
let _scanRunning = false;
let _dirtyDuringScan = false;
let _lastScanFinishedAt = 0;

function scheduleScan() {
  // 已在跑：标记 dirty，等当前扫描结束后处理
  if (_scanRunning) {
    _dirtyDuringScan = true;
    return;
  }
  // 已排好队：忽略（防抖窗口内多事件合并）
  if (_scanTimer) return;
  // 距上次扫描完成不久 + 有新事件 → 用更短的延迟（用户连续点导入时反应更快）
  const sinceLastScan = Date.now() - _lastScanFinishedAt;
  const delay = sinceLastScan < TAIL_RESCAN_MS ? 200 : LEADING_DELAY_MS;
  _scanTimer = setTimeout(async () => {
    _scanTimer = null;
    _scanRunning = true;
    _dirtyDuringScan = false;
    try {
      await scanAndSync();
    } catch (e) {
      logger.error("[callback] scanAndSync 异常: %s", e.stack);
    } finally {
      _scanRunning = false;
      _lastScanFinishedAt = Date.now();
      // 跑期间又来了事件 → 立即补扫（不再防抖，用户已经在等了）
      if (_dirtyDuringScan) {
        logger.debug("[callback] 扫描期间有新事件，补扫一次");
        scheduleScan();
      }
    }
  }, delay);
}

/**
 * 扫描所有行，找到"是否确定导入"="导入"的行，批量触发同步
 */
async function scanAndSync() {
  const syncJob = getSyncJob();
  const result = await syncJob.processPendingImports();
  if (result?.error) {
    logger.error("[callback] 待导入批处理失败: %s", result.error);
    return;
  }
  logger.info("[callback] 批量处理完成: ok=%d failed=%d skipped=%d total=%d",
    result.ok || 0, result.failed || 0, result.skipped || 0, result.total || 0);
}

function parseXml(xml) {
  const out = {};
  const re = /<(\w+)>(?:<!\[CDATA\[([^\]]*)\]\]>|([^<]*))<\/\1>/g;
  let m;
  while ((m = re.exec(xml)) !== null) out[m[1]] = m[2] ?? m[3];
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

function handleVerify(u, res) {
  const msg_signature = u.searchParams.get("msg_signature");
  const timestamp = u.searchParams.get("timestamp");
  const nonce = u.searchParams.get("nonce");
  const echostr = u.searchParams.get("echostr");

  if (!verifySignature(TOKEN, timestamp, nonce, echostr, msg_signature)) {
    logger.warn("[callback] 签名校验失败");
    res.writeHead(401).end("bad signature");
    return;
  }
  try {
    const { msg } = decrypt(echostr, AES_KEY);
    res.writeHead(200, { "Content-Type": "text/plain" }).end(msg);
    logger.info("[callback] URL 验证通过");
  } catch (e) {
    logger.error("[callback] echostr 解密失败: %s", e.message);
    res.writeHead(500).end("decrypt error");
  }
}

async function handleEvent(u, req, res) {
  const msg_signature = u.searchParams.get("msg_signature");
  const timestamp = u.searchParams.get("timestamp");
  const nonce = u.searchParams.get("nonce");
  const body = await readBody(req);
  const xml = parseXml(body);
  const encrypted = xml.Encrypt;

  if (!verifySignature(TOKEN, timestamp, nonce, encrypted, msg_signature)) {
    logger.warn("[callback] POST 签名校验失败");
    res.writeHead(401).end("bad signature");
    return;
  }
  let event;
  try {
    const { msg } = decrypt(encrypted, AES_KEY);
    event = parseXml(msg);
  } catch (e) {
    logger.error("[callback] 事件解密失败: %s", e.message);
    res.writeHead(500).end();
    return;
  }

  // 持久化 + 触发同步都要求是我们监听的那个 docid 的事件
  // 不相关 docid（例如同一企业里其他文档的变更）只留 logger 轨迹，不落库、不触发
  const docid = event.DocId || event.Docid || event.docid;
  if (!docid) {
    logger.warn("[callback] 事件无 docid 字段: %o", event);
  } else if (docid === config.wecom.sheet.docid) {
    db.logCallbackEvent(event);
    db.upsertDocid({
      docid,
      event: event.Event || event.EventType || "",
      op_user: event.FromUserName || event.User || "",
      raw: JSON.stringify(event),
    });
    logger.info("[callback] 收到本 docid 事件 event=%s user=%s → 触发扫描",
      event.Event, event.FromUserName);
    // 触发扫描（防抖）
    scheduleScan();
  } else {
    logger.info("[callback] 收到无关 docid=%s（忽略）", docid);
  }

  // 成功收到的应答：企微要求返回 "success"（明文即可，也可返回加密空包）
  res.writeHead(200, { "Content-Type": "text/plain" }).end("success");
}

function createServer() {
  return http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname !== "/wecom/callback") {
      res.writeHead(404).end("not found");
      return;
    }
    try {
      if (req.method === "GET") return handleVerify(u, res);
      if (req.method === "POST") return await handleEvent(u, req, res);
      res.writeHead(405).end();
    } catch (e) {
      logger.error("[callback] 未捕获错误: %s", e.stack);
      res.writeHead(500).end();
    }
  });
}

function start() {
  if (!TOKEN || !AES_KEY) {
    throw new Error("WECOM_CALLBACK_TOKEN / WECOM_CALLBACK_AES_KEY 未配置");
  }
  const server = createServer();
  server.listen(PORT, HOST, () => {
    logger.info("[callback] listening %s:%d  receiveId=%s", HOST, PORT, RECEIVE_ID);
  });
  return server;
}

module.exports = { start, createServer };

if (require.main === module) start();
