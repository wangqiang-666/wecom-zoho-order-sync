/**
 * 集中配置 —— 从 .env 读取，启动时校验并打印自检摘要
 * 模式参考现有项目 digital-employee-order-broadcaster/api/src/config.js
 */

require("dotenv").config();

const path = require("path");
const fs = require("fs");

const ZOHO_API_URLS = {
  sandbox: "https://sandbox.zohoapis.com.cn/crm/v2",
  production: "https://www.zohoapis.com.cn/crm/v2",
};
const ZOHO_ACCOUNTS_URLS = {
  sandbox: "https://accounts.zoho.com.cn",
  production: "https://accounts.zoho.com.cn",
};

const PLACEHOLDER = /^<.*>$/;
const isPlaceholder = (v) => {
  if (!v || typeof v !== 'string') return true;
  return PLACEHOLDER.test(v.trim());
};

function requireEnv(name) {
  const v = process.env[name];
  if (!v || typeof v !== 'string' || isPlaceholder(v)) {
    throw new Error(`[配置校验] 缺少必填环境变量: ${name}`);
  }
  return v.trim();
}
function optEnv(name, fallback) {
  const v = process.env[name];
  if (!v || typeof v !== 'string' || isPlaceholder(v)) return fallback;
  return v.trim();
}
function mask(v) {
  if (!v || v.length < 8) return "***";
  return v.slice(0, 4) + "****" + v.slice(-4);
}

const zohoEnv = optEnv("ZOHO_ENV", "sandbox");
if (!["sandbox", "production"].includes(zohoEnv)) {
  throw new Error(`ZOHO_ENV 非法: ${zohoEnv}`);
}

const config = {
  env: zohoEnv,
  isSandbox: zohoEnv === "sandbox",
  isProduction: zohoEnv === "production",
  healthPort: Number(optEnv("HEALTH_PORT", "3300")),
  logLevel: optEnv("LOG_LEVEL", "info"),

  zoho: {
    clientId: requireEnv("ZOHO_CLIENT_ID"),
    clientSecret: requireEnv("ZOHO_CLIENT_SECRET"),
    refreshToken: requireEnv("ZOHO_REFRESH_TOKEN"),
    apiBaseUrl: optEnv("ZOHO_API_BASE_URL", ZOHO_API_URLS[zohoEnv]),
    accountsUrl: optEnv("ZOHO_ACCOUNTS_URL", ZOHO_ACCOUNTS_URLS[zohoEnv]),
    moduleApiName: optEnv("ZOHO_MODULE_API_NAME", "CustomModule18"),
    defaultOwnerEmail: optEnv("ZOHO_DEFAULT_OWNER_EMAIL", ""),
    defaultOwnerId: optEnv("ZOHO_DEFAULT_OWNER_ID", ""),
    defaultCurrency: optEnv("ZOHO_DEFAULT_CURRENCY", "RMB"),
    technicalKeyFieldApiName: optEnv("ZOHO_TECHNICAL_KEY_FIELD_API_NAME", ""),
  },

  wecom: {
    corpId: requireEnv("WECOM_CORP_ID"),
    agentId: Number(requireEnv("WECOM_AGENT_ID")),
    agentSecret: requireEnv("WECOM_AGENT_SECRET"),
    notifyTo: optEnv("WECOM_NOTIFY_TO", "@all"),
    sheet: {
      docid: requireEnv("WECOM_SHEET_DOCID"),
      tab: optEnv("WECOM_SHEET_TAB", ""),
      viewId: optEnv("WECOM_SHEET_VIEW_ID", ""),
    },
  },

  poll: {
    intervalMinutes: Number(optEnv("POLL_INTERVAL_MINUTES", "2")),
    maxRows: Number(optEnv("POLL_MAX_ROWS", "200")),
    zohoWriteIntervalMs: Number(optEnv("ZOHO_WRITE_INTERVAL_MS", "0")),
    // 并发度：自动编号已改为本地生成，ZOHO 不再有 autonumber/workflow 并发问题
    // 4 是经验值（沙盒 ~5 QPS，正式 ~10 QPS），太大会触发 429
    zohoConcurrency: Math.max(1, Number(optEnv("ZOHO_CONCURRENCY", "4"))),
    // 失败通知去抖：同一行连续失败超过此次数后，仍写 DB/回写状态列，但不再入通知队列
    // 同事在企微清空状态列 = 重置计数（视为人工介入信号）
    maxNotifyAttempts: Math.max(1, Number(optEnv("MAX_NOTIFY_ATTEMPTS", "5"))),
  },

  // 多子表配置：.env 兜底，DB app_config 可覆盖（见 runtime-config.js）
  sheets: {
    prefix: optEnv("WECOM_SHEET_PREFIX", "CS_"),
    // CSV 白名单；留空表示"所有 prefix 匹配的子表"
    namesOverride: optEnv("WECOM_SHEET_NAMES", ""),
  },

  db: { path: optEnv("DB_PATH", "./data/orders.db") },
  cron: { dailyReport: optEnv("DAILY_REPORT_CRON", "0 9 * * *") },
};

// 加载 field-map（容忍 JSON 顶部 /* ... */ 注释）
const fieldMapPath = path.join(__dirname, "..", "config", "field-map.json");
const fmRaw = fs.readFileSync(fieldMapPath, "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")  // 去 /* ... */ 块注释
  .replace(/^\s*\/\/.*$/gm, "");      // 去 // 行注释
config.fieldMap = JSON.parse(fmRaw);

if (config.zoho.technicalKeyFieldApiName === "field235") {
  throw new Error("ZOHO_TECHNICAL_KEY_FIELD_API_NAME 不能配置为 field235；field235 是业务字段「订单确认编号」");
}

function printSummary(logger) {
  const banner = config.isProduction
    ? "🔴 正式环境 (PRODUCTION)"
    : "🟢 沙盒环境 (SANDBOX)";
  logger.info("========================================");
  logger.info("  wecom-zoho-order-sync 配置自检");
  logger.info("========================================");
  logger.info("  环境          : %s", banner);
  logger.info("  ZOHO API      : %s", config.zoho.apiBaseUrl);
  logger.info("  ZOHO 模块     : %s", config.zoho.moduleApiName);
  logger.info("  ZOHO ClientID : %s", mask(config.zoho.clientId));
  logger.info("  ZOHO Refresh  : %s", mask(config.zoho.refreshToken));
  logger.info("  同步账号邮箱  : %s",
    config.zoho.defaultOwnerEmail || "⚠ 未配置，写入会失败");
  logger.info("  默认币种      : %s", config.zoho.defaultCurrency);
  logger.info("  技术唯一键字段 : %s",
    config.zoho.technicalKeyFieldApiName || "（未配置，仅依赖本地 SQLite 去重）");
  logger.info("  企微 CorpID   : %s", config.wecom.corpId);
  logger.info("  企微 AgentID  : %d", config.wecom.agentId);
  logger.info("  企微 Secret   : %s", mask(config.wecom.agentSecret));
  logger.info("  表格 docid    : %s", config.wecom.sheet.docid);
  logger.info("  通知范围      : %s", config.wecom.notifyTo);
  logger.info("  轮询间隔      : 每 %d 分钟", config.poll.intervalMinutes);
  logger.info("  字段映射      : %d 条", config.fieldMap.fields.length);
  logger.info("  数据库        : %s", config.db.path);
  logger.info("========================================");
  if (config.isProduction) {
    logger.warn("⚠⚠⚠ 当前为 ZOHO 正式环境，写入会进真实 CRM！");
  }
}

function getLockedRequiredSources() {
  // 系统硬性要求的字段（不可在 admin UI 取消勾选）：
  //   - 主题 (Name)：ZOHO API 唯一必填
  //   - 渠道名称 (field50)：后端生成文件编号必需（用于反查客户编号）
  return new Set(
    (config.fieldMap?.fields || [])
      .filter((spec) => spec?.source && (
        spec.source === "主题" ||
        spec.target === "Name" ||
        spec.source === "渠道名称" ||
        spec.target === "field50"
      ))
      .map((spec) => spec.source)
  );
}

function getAllFieldSpecs() {
  const locked = getLockedRequiredSources();
  return (config.fieldMap?.fields || [])
    .filter((spec) => spec?.source)
    // 过滤掉只在后端使用的字段：
    //   - type=local（如「导入状态」，是后端回写状态用的，不属于同事录单字段）
    //   - target 以 _ 开头的内部占位（如 _LOCAL_）
    .filter((spec) => spec.type !== "local" && !String(spec.target || "").startsWith("_"))
    .map((spec) => ({
      source: spec.source,
      target: spec.target,
      type: spec.type,
      locked: locked.has(spec.source),
      defaultRequired: !!spec.required,
    }));
}

config.printSummary = printSummary;
config.getLockedRequiredSources = getLockedRequiredSources;
config.getAllFieldSpecs = getAllFieldSpecs;
module.exports = config;
