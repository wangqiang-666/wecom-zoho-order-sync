# wecom-zoho-order-sync 架构设计

## 目标
企业微信智能表格「销售订单订单导入」→ ZOHO CRM `CustomModule18`，每天 200-500 单，本地 Mac mini 长期运行，失败/成功通过企微群机器人通知。

## 核心原则
1. **webhook实时触发 + 轮询兜底**：webhook提供实时性（3秒防抖），轮询确保可靠性（60秒兜底）。
2. **幂等**：每条企微表格行用唯一标识（行 ID 或业务键）做去重，重启/重跑不会写脏数据。
3. **冷静期保护**：新行/修改的行进入120秒冷静期，避免打扰录入；点击"导入"可跳过。
4. **dry_run 优先**：所有写入逻辑都支持 `--dry-run`，先跑通字段映射再开闸。
5. **沙盒先行**：默认指向 ZOHO 沙盒（`sandbox.zohoapis.com.cn`），切环境只改 `.env` 一行。
6. **机器人和同步解耦**：同步进程负责写库 + 入消息队列；通知由独立 job 消费，机器人挂了不影响主链路。
7. **并发安全**：多层锁机制（跨进程文件锁 + 进程内串行锁 + ZOHO并发控制 + 文件编号去重）。

## 模块划分

```
wecom-zoho-order-sync/
├── src/
│   ├── index.js                  # 入口：启动调度器 + healthcheck
│   ├── config.js                 # 集中配置（env 校验 + 自检摘要，复用现有项目模式）
│   ├── services/
│   │   ├── zoho-auth.js          # OAuth token 管理（refresh_token → access_token）
│   │   ├── zoho-write.js         # 创建订单（POST /CustomModule18，仅创建不更新），含 dry_run
│   │   ├── wecom-sheet.js        # 读企微智能表格 + 回写状态 + Reference字典缓存
│   │   ├── wecom-app.js          # 企微自建应用「小智」消息推送
│   │   ├── wecom-callback.js     # 企微文档事件回调（webhook接收 + 防抖触发）
│   │   ├── wecom-crypto.js       # 企微回调加解密（AES-CBC + SHA1签名）
│   │   └── admin-server.js       # Web管理界面 + HTTP API（端口3300）
│   ├── mappers/
│   │   └── value-transform.js    # 类型转换：日期、数字、picklist 校验、lookup 解析
│   ├── jobs/
│   │   ├── sync-job.js           # 主同步任务：读表 → 冲突检测 → 映射 → 并发写ZOHO → 回写状态
│   │   └── notify-job.js         # 消费通知队列 → 调企微机器人 + 日报
│   ├── utils/
│   │   ├── logger.js             # winston 日志
│   │   ├── db.js                 # SQLite：sync_state、notify_queue、app_config
│   │   ├── runtime-config.js     # 运行时配置（DB优先，.env兜底）
│   │   └── file-no.js            # 文件编号生成器（IN/NP/<客户编号>/<A-Z+4位数字>/<年>，全局按年顺序计数）
├── config/
│   └── field-map.json            # 主表 ↔ ZOHO 映射，支持热改不重启
├── data/
│   └── orders.db                 # SQLite（同步状态 + 通知队列）
├── docs/
│   ├── ARCHITECTURE.md           # 本文档
│   ├── FIELD_MAPPING.md          # 38 字段对照表（含类型/picklist 约束）
│   └── DEPLOY.md                 # Mac mini launchd 部署
├── scripts/
│   ├── pull-zoho-meta.js         # 一次性：拉 ZOHO 元数据生成 field-map 模板
│   ├── dry-run.js                # 单条/批量 dry-run 校验
│   └── reset-test.js             # 沙盒清理
├── logs/                         # winston 日志
├── .env.example
├── package.json
└── README.md
```

## 数据流

```
[企微智能表格]
      │  每 1-2 分钟轮询
      ▼
┌─────────────────────┐
│ wecom-sheet.read    │  读全部「待同步」行（导入状态 != 已成功）
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│ field-map + transform│  列名重映射 + 类型转换 + picklist 白名单校验
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│ validators           │  必填字段、长度、格式
└─────────┬───────────┘
          │ 失败 ──► 写 sync_state=failed + 入 notify 队列（带原因）
          │ 通过 ▼
┌─────────────────────┐
│ zoho-write.create   │  POST CustomModule18，dry_run 模式只校验不写
└─────────┬───────────┘
          │ 失败 ──► 重试 3 次 ──► 仍失败：同上失败分支
          │ 成功 ▼
┌─────────────────────┐
│ wecom-sheet.update  │  回写「导入状态=导入成功」+ ZOHO ID
│ + sync_state=ok     │
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│ notify-job          │  汇总后推送企微群（每批 / 每日报）
└─────────────────────┘
```

## 去重 / 幂等
SQLite 表 `sync_state(row_id PK, business_key, zoho_id, status, last_error, created_at, updated_at)`。
- `row_id`：企微行的唯一 ID（`wecom::<sheetId>::<recordId>`）
- `business_key`：业务唯一键（订单确认编号 field235）
- `zoho_id`：ZOHO CRM 返回的 record_id；一旦写入就"封印"这一行

## 核心铁律：一行企微记录 = 一条 ZOHO 订单

v2 版本彻底移除了"更新"语义，只保留"创建"：

- **已同步成功的行（有 `zoho_id`）= 历史档案**：系统永远不会再修改 ZOHO 里那条记录
- 想改 ZOHO 订单内容 → 用户直接去 ZOHO 改
- 想新建一条 → 在企微新增一行 / 删行后同位置重录 / 已同步行上改内容（hash 变化）

**为什么移除 PUT 更新：** 企微 `record_id` 在行删除后可能被复用。旧版本用 `row_id` → `zoho_id` 查 DB 做 PUT，会把新内容覆盖到同位置的旧 ZOHO 记录上（灾难性数据损坏，旧订单被改写、新订单丢失）。v2 只做 POST 创建，数据隔离。

### processOne 判断矩阵

| DB 状态 | zoho_id | hash 对比 | 企微状态列 | 动作 |
|---------|---------|-----------|-----------|------|
| 无记录 | - | - | - | POST 创建（首次） |
| ok | 有 | 一致 | 有 | 跳过（稳态） |
| ok | 有 | 一致 | 空 | 仅补回写 updateStatus（假失败兜底，ZOHO 成功但企微回写失败） |
| ok | 有 | 不一致 | - | 识别为"同位置新记录" → 删 DB 旧记录 → POST 创建（旧 ZOHO 不动）|
| failed | 无 | 一致 | 有 | 跳过（避免无意义重试）|
| failed | 无 | 一致 | 空 | 重试 POST（用户清状态列 = 请求重试） |
| failed | 无 | 不一致 | - | 重试 POST（用户改了内容） |

## 并发保护（四层防御）

ZOHO 沙盒 + 企微 SmartsheetV2 对高并发都很敏感，"一行 = 一条 ZOHO"铁律必须在所有入口下都成立：

1. **进程内串行锁** (`_runOncePromise`)：同进程多次调用不会并行进 runOnce
2. **跨进程文件锁** (`sync.lock`)：所有入口（cron tick、webhook、admin 手动触发、processSingleRow）统一抢锁，同一时刻只有一条路径处理
3. **Stage 2 POST 前的 `fresh` 重检**：防御窗口期残留并发
4. **企微写入子表队列** (`_sheetWriteQueues`)：按 sheetId 串行 + 自动重试 `[2040035]` 服务错误，避免假失败误判

## 机器人通知策略
- **失败立即通知**：单条失败 → 5 秒去抖后推群（避免连环报警）
- **每日汇总**：早 9 点推「昨日同步 X 单，成功 Y，失败 Z（明细）」
- **健康心跳**：服务异常退出由 launchd 拉起；连续 3 次轮询失败发紧急消息

## 配置文件分层
| 文件             | 内容                       | 改动频率 |
|------------------|----------------------------|----------|
| `.env`           | 凭证、URL、端口、环境标识  | 极少     |
| `field-map.json` | 列名映射、picklist 白名单  | 中等（主表加字段时改） |
| 代码             | 业务流程                   | 低       |

## 部署
launchd plist，开机自启，stdout/stderr 落 `logs/`，崩溃自动重启。详见 `docs/DEPLOY.md`。
