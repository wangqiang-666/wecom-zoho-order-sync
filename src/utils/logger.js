/**
 * 简易 winston 日志：控制台 + 按日切分文件
 */
const path = require("path");
const fs = require("fs");
const winston = require("winston");
const config = require("../config");

const logDir = path.join(__dirname, "..", "..", "logs");
// mkdir 失败时降级为仅控制台输出，避免日志目录不可写阻断启动
let fileTransportEnabled = true;
try {
  fs.mkdirSync(logDir, { recursive: true });
} catch (e) {
  fileTransportEnabled = false;
  // eslint-disable-next-line no-console
  console.error(`[logger] 创建日志目录失败 ${logDir}: ${e.message}，将仅输出到控制台`);
}

const transports = [new winston.transports.Console()];
if (fileTransportEnabled) {
  transports.push(new winston.transports.File({
    filename: path.join(logDir, "sync.log"),
    maxsize: 10 * 1024 * 1024,
    maxFiles: 14,
  }));
}

const logger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.splat(),
    winston.format.printf(({ timestamp, level, message }) =>
      `${timestamp} [${level.toUpperCase()}] ${message}`
    )
  ),
  transports,
});

module.exports = logger;
