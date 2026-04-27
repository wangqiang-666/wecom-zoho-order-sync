/**
 * 企微回调 AES-CBC + PKCS7 + 签名 工具
 * 官方协议： https://developer.work.weixin.qq.com/document/path/90968
 */

const crypto = require("crypto");

function sha1(...parts) {
  return crypto.createHash("sha1").update(parts.sort().join("")).digest("hex");
}

function aesKey(encodingAESKey) {
  return Buffer.from(encodingAESKey + "=", "base64");
}

function pkcs7Unpad(buf) {
  const pad = buf[buf.length - 1];
  return pad < 1 || pad > 32 ? buf : buf.slice(0, buf.length - pad);
}

function pkcs7Pad(buf) {
  const blockSize = 32;
  const pad = blockSize - (buf.length % blockSize);
  return Buffer.concat([buf, Buffer.alloc(pad, pad)]);
}

function decrypt(encrypted, encodingAESKey) {
  const key = aesKey(encodingAESKey);
  const iv = key.slice(0, 16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);
  const raw = Buffer.concat([decipher.update(encrypted, "base64"), decipher.final()]);
  const unpadded = pkcs7Unpad(raw);

  // 前 16 字节随机；4 字节 msg 长度（BE）；N 字节 msg；剩下 receiveid
  const msgLen = unpadded.readUInt32BE(16);
  const msg = unpadded.slice(20, 20 + msgLen).toString("utf8");
  const receiveId = unpadded.slice(20 + msgLen).toString("utf8");
  return { msg, receiveId };
}

function encrypt(plainText, encodingAESKey, receiveId) {
  const key = aesKey(encodingAESKey);
  const iv = key.slice(0, 16);
  const random = crypto.randomBytes(16);
  const msg = Buffer.from(plainText, "utf8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msg.length, 0);
  const full = Buffer.concat([random, lenBuf, msg, Buffer.from(receiveId, "utf8")]);
  const padded = pkcs7Pad(full);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
}

function verifySignature(token, timestamp, nonce, encrypted, signature) {
  return sha1(token, timestamp, nonce, encrypted) === signature;
}

function signature(token, timestamp, nonce, encrypted) {
  return sha1(token, timestamp, nonce, encrypted);
}

module.exports = { decrypt, encrypt, verifySignature, signature };
