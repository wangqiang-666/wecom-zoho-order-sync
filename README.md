# wecom-zoho-order-sync

企业微信智能表格「销售订单导入」→ ZOHO CRM `CustomModule18` 自动同步服务。
多同事独立子表并行，准实时回写，失败/日报通过企微小智机器人推送。

> **v2 铁律：一行企微记录 = 一条 ZOHO 订单。** 系统仅做创建（POST），不做更新（无 PUT）。
> 已同步成功的行视为"历史档案"，改内容 = 新建订单（旧 ZOHO 记录不动）。
> 想改 ZOHO 订单 → 用户直接去 ZOHO 改。详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

---

## 一、系统全貌

```
 ┌──────────────── 企业微信 智能表格 (同一 docid) ────────────────┐
 │  CS_Erik   CS_Krystal   CS_Mag   CS_Winny   CS_Nick           │
 │  CS_Rose   CS_Stella    CS_Echo  CS_IT*                       │
 │           ↑ 每位同事一张子表，38 字段统一结构                   │
 └─────────────────────┬──────────────────────────────────────────┘
                       │ ① 轮询兜底 (60s)  +  ② webhook实时触发 (debounce 3s)
                       ▼
            ┌──────────────────────────────┐
            │   wecom-zoho-order-sync      │
            │                              │
            │  ● readRows 跨表扁平化       │
            │  ● 跨表订单号冲突检测        │
            │  ● field-map 38 字段精确映射 │
            │  ● file_no 全局按年顺序生成   │
            │  ● SQLite 去重 + 重试队列    │
            │  ● 冷静期保护 (120s)         │
            │                              │
            │  Web UI:3300   回调:8080     │
            └──────────────────┬───────────┘
                               │ 并发写 (4 workers)
                               ▼
                      ZOHO CRM CustomModule18
                               │
                               ▼
                   失败/日报 → 企微「小智」机器人
```

> `CS_IT` 默认在黑名单里不参与同步，UI 上可切换。

---

## 二、核心功能

| 能力 | 说明 |
|---|---|
| **多子表并行** | 同一 docid 下所有 `CS_*` 子表自动发现，每位同事一张表，互不干扰 |
| **动态监听配置** | Web UI 每个表一个开关，增删黑名单/白名单即时生效，无需重启 |
| **准实时同步** | ① 轮询兜底（默认 60 秒，UI 可改）② webhook实时触发（3秒防抖）③ 点击"导入"立即执行 |
| **冷静期保护** | 新行/修改的行进入120秒冷静期，避免打扰录入；点击"导入"可跳过 |
| **跨子表订单号冲突保护** | 两张表写同一订单号 → 两条都标失败，**不写 ZOHO**，导入状态列显示冲突详情 |
| **Reference 字典按 sub_id 隔离** | 每位同事的「渠道名称」指向不同字典子表（Erik 11 项 / Krystal 179 项），各自缓存互不污染 |
| **文件编号全局唯一** | `IN/NP/<客户编号>/<A-Z+4位数字>/<年>`（如 `IN/NP/12421/A0001/2026`），全局按年顺序计数（A0001..Z9999），SQLite 事务原子预留，本地丢失可从 ZOHO 近期记录恢复 |
| **必填字段在线配置** | Web UI 动态调整必填字段，无需修改代码或重启服务 |
| **失败重试 + 熔断** | SQLite 记录 attempts，指数退避；回写企微「导入状态」列让用户看到原因 |
| **通知开关** | 默认关闭（开发期），UI 一键开启；关闭时失败仍记 DB，只是不推微信 |
| **幂等去重** | 以 `rowId = wecom::<sheetId>::<recordId>` 为主键，行哈希判内容变更；hash 变化 + 已有 zoho_id = 同位置新记录 |
| **仅创建不更新** | v2 版本只做 POST，不做 PUT。已同步行永远不再触碰 ZOHO，修改视为新订单 |
| **并发处理** | 4个worker并发写入ZOHO，批量处理性能优秀（50条约30-60秒）|
| **多层并发防护** | 文件锁 + 进程内锁 + 写前重检 + 子表写队列，所有入口统一抢锁 |

---

## 二·1、「导入状态」列只有三种

| 状态 | 含义 | 用户动作 |
|------|------|---------|
| **导入中** | 系统接到请求，正在处理 | 等几秒 |
| **导入成功 (zoho=xxx)** | 已创建 ZOHO 记录 | 完成；想改去 ZOHO 改 |
| **导入失败: 原因** | 创建失败（校验/网络/冲突） | 修改企微行内容 或 清空状态列 触发重试 |

---

## 三、目录速览

```
src/
├── index.js                      服务入口：cron 调度 + 回调 + admin server 串起来
├── config.js                     .env 读取、启动自检、field-map 加载
├── services/
│   ├── wecom-sheet.js            多子表读/写，Reference 字典按 sub_id 缓存
│   ├── wecom-callback.js         企微文档变更事件接收（加解密 + docid 过滤）
│   ├── wecom-crypto.js           企微回调 AES-CBC + SHA1 签名
│   ├── wecom-app.js              自建应用小智：access_token + 发消息
│   ├── zoho-auth.js              refresh_token → access_token
│   ├── zoho-write.js             CustomModule18 仅 POST 创建（v2 移除 PUT 更新）
│   └── admin-server.js           HTTP admin + 内嵌单页 UI (port 3300)
├── jobs/
│   ├── sync-job.js               runOnce 主流程：读→冲突检测→映射→写→回状态
│   └── notify-job.js             fail 队列 flush + 每日汇总
├── utils/
│   ├── db.js                     better-sqlite3 schema + stmt 封装
│   ├── runtime-config.js         DB app_config 优先，.env 兜底（过滤规则/间隔/通知开关）
│   ├── file-no.js                file_no 生成器（全局串行计数）
│   └── logger.js                 winston 配置
└── mappers/
    └── value-transform.js        字段级类型/picklist/lookup 转换

config/field-map.json             38 字段映射规则（支持 JSON 内 /* */ 注释）
scripts/                          运营脚本（见第八节）
data/orders.db                    SQLite 持久化（WAL 模式）
logs/                             winston 滚动日志
docs/                             历史详细文档（架构/部署/字段/运维）
```

---

## 四、快速开始

### 首次部署

```bash
# 1) 装依赖
npm install

# 2) 填凭证
cp .env.example .env
# 编辑 .env，至少确认：
#   ZOHO_REFRESH_TOKEN           → ZOHO OAuth2 refresh_token
#   ZOHO_DEFAULT_OWNER_EMAIL     → ZOHO 同步账号邮箱
#   WECOM_CORP_ID / AGENT_ID / AGENT_SECRET → 企微自建应用「小智」
#   WECOM_SHEET_DOCID            → 智能表格 docid

# 3) 拉取 ZOHO 元数据（首次 + 字段结构变更时跑）
node scripts/pull-zoho-meta.js

# 4) 校验 field-map 是否和 ZOHO 端一致
node scripts/verify-field-map.js

# 5) dry-run（只校验不写 ZOHO）
node scripts/dry-run.js

# 6) 正式启动
npm start
```

启动后看到：

```
[runtime] sheets filter = { prefix: 'CS_', names: [], excludes: ['CS_IT'] }
[sync]    轮询已调度: */3 * * * *
[admin]   UI 已启动 http://127.0.0.1:3300/
[callback] listening 127.0.0.1:8080
```

### 后台守护（macOS / launchd）

```bash
cp scripts/com.inotary.wecom-zoho-sync.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.inotary.wecom-zoho-sync.plist
# 卸载：launchctl unload ~/Library/LaunchAgents/com.inotary.wecom-zoho-sync.plist
```

---

## 五、Web 控制台 `http://127.0.0.1:3300/`

| 卡片 | 作用 |
|---|---|
| **当前状态** | docid、轮询间隔、冷静期、生效子表、filter 规则 |
| **监听的子表** | 每个已发现 `CS_*` 一行 + 监听开关；底部「添加新表」输入框 + 「刷新发现」按钮（docid 下新建子表后点一下就能识别） |
| **同步触发** | 「立即同步一次」手动触发；实时触发模式说明（点击"导入"立即执行） |
| **企微通知** | 失败/日报推送开关。默认关，开发期建议保持；关闭时失败仍记 DB，只是不发企微 |
| **录单必填字段** | 在线配置哪些字段必填，支持保存/重置，锁定字段不可取消 |
| **近 24 小时** | 成功 / 失败 / 待处理计数 |
| **最近失败** | 最新 10 条：订单号、错误片段、重试次数、时间 |

底层 API（curl 也能用）：

| Endpoint | Method | 说明 |
|---|---|---|
| `/health` | GET | 存活探针 |
| `/api/status` | GET | 全量状态 JSON |
| `/api/sheet-toggle` | POST `{title, enabled}` | 单表开/关监听 |
| `/api/refresh-sheets` | POST | 强制重拉 docid 下的子表清单 |
| `/api/sheets` | POST `{names: "CS_A,CS_B"}` | 批量设白名单 (CSV，空=恢复自动发现) |
| `/api/interval` | POST `{sec: 180}` | 改轮询间隔 |
| `/api/notify` | POST `{enabled: true/false}` | 通知开关 |
| `/api/run-now` | POST | 立即触发一次 `runOnce` |

---

## 六、配置优先级

```
DB app_config (Web UI 改的)  >  .env  >  内置默认
```

重要的可热切换 key：

| DB key | .env 兜底 | 默认 |
|---|---|---|
| `sheet_prefix` | `WECOM_SHEET_PREFIX` | `CS_` |
| `sheet_names_override` | `WECOM_SHEET_NAMES` | `""` (=按 prefix 自动发现) |
| `sheet_excludes` | — | `CS_IT` |
| `poll_interval_sec` | `POLL_INTERVAL_MINUTES × 60` | 120 |
| `notify_enabled` | — | `false` |

过滤规则：
- **白名单 (`names`) 非空** → 严格匹配，黑名单忽略
- **白名单空** → `prefix` 匹配后再减去 `excludes`

---

## 七、数据库 schema

SQLite 一张库 `data/orders.db`，WAL 模式：

| 表 | 用途 |
|---|---|
| `sync_state` | 每行主状态：row_id(PK)、business_key(订单号)、status、zoho_id、file_no、attempts、last_error、hash |
| `notify_queue` | 失败/事件消息队列，notify-job flush 后发企微 |
| `file_no_counter` | 全局 file_no 自增锁，保证编号唯一 |
| `wecom_docid` | 回调抓到的 docid 映射，过滤无关文档事件 |
| `callback_event_log` | 回调事件审计（调试用） |
| `app_config` | 运行时 key/value，Web UI 写 |

---

## 八、运营脚本（`scripts/`）

精简后只留 8 个高频命令：

| 脚本 | 说明 |
|---|---|
| `test-multi-sheet-loop.js` | **闭环测试** — seed / sync / verify / cleanup / all，多表并行 + 跨表冲突双场景 |
| `dry-run.js` | 干跑一轮：读 + 校验 + 映射，但不写 ZOHO 不回状态 |
| `pull-zoho-meta.js` | 拉 ZOHO CustomModule18 字段元数据到 `data/zoho-meta/`，用于对 field-map |
| `verify-field-map.js` | 把本地 field-map 和 ZOHO 元数据比对，列出缺失/多余/类型不一致 |
| `list-synced.js` | 列出 DB 中已成功同步的记录（行号、订单号、zoho_id、file_no） |
| `cleanup-orphan-sync-state.js` | 企微行已删但 DB 仍有 failed 状态 → 清理 |
| `cleanup-dead-zoho-refs.js` | 清理指向已删除 ZOHO 记录的反向引用 |
| `com.inotary.wecom-zoho-sync.plist` | launchd 开机自启模板 |

用法示例：

```bash
# 完整闭环测试（⚠ 会在企微表写测试行，结束自动清理）
node scripts/test-multi-sheet-loop.js all

# 只跑同步不 seed
node scripts/test-multi-sheet-loop.js sync

# 修改 field-map 后检查
node scripts/verify-field-map.js
```

---

## 九、已知约束 & 坑

1. **node-cron 只支持 5 字段（分钟级）** — UI 改到 90 秒会向上圆整到 `*/2 * * * *`。秒级兜底在 runtime-config（≥30s）。
2. **ZOHO 并发写入敏感** — 过快会 autonumber 缺失 / workflow 互相覆盖。`ZOHO_WRITE_INTERVAL_MS=3000` 是实测下限，量大时调 5000。
3. **Reference 字段按 sub_id 缓存** — 每个同事的「渠道名称」字典子表独立（tKlNxW / tUQTJZ / toAWyb…），不要改成按 field title 聚合。
4. **field235 禁止当技术唯一键** — 它是业务字段「订单确认编号」；启动校验会抛错。
5. **SELECT 字段 option id 各表可能不同** — 写企微行时必须按 text 反查 id，不能硬编码（`删除不负责证词` 是 Erik=`o1nVnW` / Krystal=`oC0LZS`）。
6. **ZOHO_ENV 切换要换 refresh_token** — 沙盒和正式是两个 portal，token 不通用。

---

## 十、排障速查

| 症状 | 往哪看 |
|---|---|
| 启动报 `缺少必填环境变量` | `.env` vs `.env.example` 字段名对齐 |
| `Smartsheet invalid reference value` | 某 SELECT/Reference 字段的 id 在目标子表不存在；检查是否按 sub_id 拉的字典 |
| 企微「导入状态」列一直「导入中」 | 看 admin `/api/status` 的 recentFailed 或 `logs/*.log` |
| 跨表冲突日志 | `grep "在多个子表重复" logs/combined.log` |
| file_no 重复 | 查 `file_no_counter` 表，以及是否有人绕过 file-no.js 直接写 ZOHO |
| 回调收不到 | `curl /api/status` 看 sheetsLive；`logs/*.log` grep `[callback]` |
| 服务起不来 | `node -c src/index.js`；或 `npm start` 看 stderr |

---

## 十一、扩展文档

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 更详细的架构分层 / 数据流
- [docs/FIELD_MAPPING.md](docs/FIELD_MAPPING.md) — 38 字段逐项对照表 + 特殊转换规则
- [docs/OPERATIONS.md](docs/OPERATIONS.md) — 运维手册（凭证、日志切割、绝对禁止清单）
- [docs/DEPLOY.md](docs/DEPLOY.md) — 首次部署步骤详解
- [docs/DEPLOYMENT-LOG.md](docs/DEPLOYMENT-LOG.md) — 部署变更历史
- `DEPLOY-SECRETS.md` — 凭证清单（gitignore，本地查）

---

## 十二、切换沙盒 ↔ 正式

```diff
- ZOHO_ENV=sandbox
+ ZOHO_ENV=production
- ZOHO_REFRESH_TOKEN=1000.xxx...（沙盒）
+ ZOHO_REFRESH_TOKEN=1000.yyy...（正式 portal 新生成）
- ZOHO_DEFAULT_OWNER_EMAIL=zoho@inotary.com.hk（沙盒）
+ ZOHO_DEFAULT_OWNER_EMAIL=<正式同步账号>@inotary.com.hk
```

切换后：

```bash
node scripts/pull-zoho-meta.js       # 重拉元数据
node scripts/verify-field-map.js     # 比对字段
node scripts/dry-run.js              # 干跑
npm start                            # 上线
```

⚠ 正式环境启动横幅是红色 `🔴 正式环境 (PRODUCTION)`，配置自检也会 warn，别眼瞎当沙盒用。
