# 运维手册 / OPERATIONS

> 本系统的**所有运维关键信息**。遇到任何问题先翻这里。
> 敏感凭证见 [DEPLOY-SECRETS.md](../DEPLOY-SECRETS.md)（gitignore 中，不上传）

---

## 1. 系统全景

```
┌─────────────┐  事件推送     ┌──────────────────────┐
│ 企业微信      │ ───────────→ │ https://wecom-cb     │
│ 智能表格事件  │  HTTPS POST  │ .cninotary.com       │
└─────────────┘               └──────────┬───────────┘
                                         │ CNAME
                                         ↓
                              ┌──────────────────────┐
                              │ Cloudflare Tunnel    │
                              │ (wecom-cb)           │
                              └──────────┬───────────┘
                                         │ 加密隧道（出站连接）
                           ┌─────────────┴─────────────┐
                           ↓                           ↓
                  ┌──────────────┐            ┌──────────────┐
                  │ 本地笔记本     │            │ Mac mini     │
                  │ (调试时)      │  二选一     │ (生产)       │
                  │ :8080        │            │ :8080        │
                  └──────┬───────┘            └──────┬───────┘
                         │                           │
                         │ 拿到docid后调API              │
                         ↓                           ↓
                  ┌────────────────────────────────────────┐
                  │ 企微API: qyapi.weixin.qq.com           │
                  │  - 读 CS_Erik 行                       │
                  │  - 回填导入状态                         │
                  └────────────────────────────────────────┘
                                   ↓ 转换后
                         ┌──────────────────┐
                         │ ZOHO CRM         │
                         │ CustomModule18   │
                         └──────────────────┘
```

**关键：同一时刻只有一台机器在跑 cloudflared + 回调服务。** 本地调试时切到本地，生产跑在 Mac mini。

---

## 2. 关键资产（所有ID一次看全）

### 2.1 域名 / DNS

| 项 | 值 |
|---|---|
| 主域名 | `cninotary.com`（Cloudflare Free 计划，已备案） |
| 回调子域名 | `wecom-cb.cninotary.com` |
| DNS记录类型 | CNAME → Cloudflare Tunnel（账号内自动管理，无需人工） |

### 2.2 Cloudflare Tunnel

| 项 | 值 |
|---|---|
| Tunnel 名称 | `wecom-cb` |
| Tunnel ID | `c181072d-0769-4f4a-bbef-71fddba95eb2` |
| 凭证文件 | `~/.cloudflared/c181072d-0769-4f4a-bbef-71fddba95eb2.json` |
| 登录证书 | `~/.cloudflared/cert.pem` |
| ingress配置 | `~/.cloudflared/config.yml`（→ `http://localhost:8080`） |

### 2.3 企业微信

| 项 | 值 |
|---|---|
| 企业 CorpID | `ww077b2e151608dee9` |
| 应用 | "小智"（AgentID 在 `.env`） |
| 回调URL | `https://wecom-cb.cninotary.com/wecom/callback` |
| 回调Token | 见 `.env` `WECOM_CALLBACK_TOKEN` |
| 回调AES Key | 见 `.env` `WECOM_CALLBACK_AES_KEY` |
| 可信IP | 已在后台配4个（Mac mini 公网出口 + 本地） |

### 2.4 智能表格

| 项 | 值 |
|---|---|
| 文档名 | `销售订单订单导入` |
| **docid** | `dcIEJwnqOGqzD8e3pNe77th_F2viBzBwf6vQ1P1rtkVucP3qNI-xkQGEO67ORxyM_Uv7XW0yUHCgwpPHupmpOktQ` |
| 目标子表 | `CS_Erik` |
| docid 来源 | 企微事件回调捕获（客户端创建的文档不能凭URL推断） |
| docid 持久化 | `data/orders.db` 表 `wecom_docid` |

### 2.5 ZOHO

- 环境：sandbox（.env `ZOHO_ENV`）
- 目标模块：CustomModule18
- 字段映射：`config/field-map.json`
- 凭证在 `.env`

---

## 3. 日常操作

### 3.1 启动（本地调试）

```bash
cd ~/Documents/wecom-zoho-order-sync

# 终端1：回调服务
node src/services/wecom-callback.js > logs/callback.log 2>&1 &

# 终端2：Cloudflare 隧道
cloudflared tunnel run wecom-cb > logs/tunnel.log 2>&1 &

# 验证
curl https://wecom-cb.cninotary.com/wecom/callback   # 应返回 401 bad signature
```

**⚠️ 启动前先确认 Mac mini 上没在跑**（两边抢同一隧道，行为未定义）。  
Mac mini 停服务：`ssh mac-mini 'pkill cloudflared; pkill -f wecom-callback'`

### 3.2 启动（Mac mini 生产）

```bash
# SSH 到 Mac mini（通过 Tailscale）
ssh yyzinotary@mac-mini

cd ~/wecom-zoho-order-sync
# （后续 Docker 化后用 docker compose up -d）
```

### 3.3 查日志

```bash
tail -f logs/callback.log   # 回调收到什么
tail -f logs/tunnel.log     # 隧道连接状态
```

### 3.4 查数据库

```bash
# 看已捕获 docid
sqlite3 data/orders.db "SELECT docid, event, op_user, datetime(last_seen/1000,'unixepoch','localtime') FROM wecom_docid;"

# 看同步状态
sqlite3 data/orders.db "SELECT row_id, status, last_error FROM sync_state LIMIT 20;"

# 看事件流水（排查用）
sqlite3 data/orders.db "SELECT id, event_type, datetime(received_at/1000,'unixepoch','localtime') FROM callback_event_log ORDER BY id DESC LIMIT 10;"
```

### 3.5 本地 ↔ Mac mini 切换

本地调试结束前，**先关闭本地的 cloudflared 和 callback**，再在 Mac mini 上启动。否则两边抢隧道。

```bash
# 本地停
pkill cloudflared
pkill -f wecom-callback

# Mac mini 启（SSH 过去）
ssh yyzinotary@mac-mini 'cd ~/wecom-zoho-order-sync && ./start.sh'
```

---

## 4. 排障

### "签名校验失败"
- 检查 `.env` 的 `WECOM_CALLBACK_TOKEN` 和 `WECOM_CALLBACK_AES_KEY` 是否和企微后台一致
- 检查 `WECOM_CORP_ID`（解密用到 receiveId）

### curl https://wecom-cb.cninotary.com 没响应
1. `cloudflared tunnel info wecom-cb` 看连接状态
2. `ps aux | grep cloudflared` 看进程还在不
3. `ps aux | grep wecom-callback` 看回调服务还在不
4. `curl http://127.0.0.1:8080/wecom/callback` 看本地服务通不通

### 域名主体校验未通过
- 确认企微后台填的域名是 `wecom-cb.cninotary.com`，不是 trycloudflare 临时地址
- cninotary.com 必须处于已备案、主体是公司的状态

### docid 丢了 / 要重新拿
1. 确保回调服务和隧道在跑
2. 在智能表格里**随便改一行**（比如加两个字再删掉）
3. 看 `logs/callback.log` 有没有 `捕获 docid=...`
4. 存进数据库：`sqlite3 data/orders.db "SELECT docid FROM wecom_docid"`

---

## 5. 绝对不要做的事

- ❌ 不要同时在本地和 Mac mini 上启动 cloudflared（同一隧道两边抢，行为未定义）
- ❌ 不要在 Cloudflare 面板删除 `wecom-cb` 这条 CNAME（除非要停服）
- ❌ 不要修改 `cninotary.com` 的 NS 或主站记录
- ❌ 不要把 `.env`、`DEPLOY-SECRETS.md`、`.cloudflared/*.json` 提交到 git
- ❌ ZOHO_ENV=production 只在正式上线时切换，否则保持 sandbox

---

## 6. 账号恢复 / 交接

- Cloudflare 账号：`it@inotary.com.hk`（详细凭证见 DEPLOY-SECRETS.md）
- 企微管理后台：通过 IT 管理员授权
- ZOHO：使用现有 refresh token，过期需重新 OAuth 授权
