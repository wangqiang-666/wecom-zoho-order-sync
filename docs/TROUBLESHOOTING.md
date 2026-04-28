# 故障排查指南

## 常见问题

### 1. 已同步的行改内容后又创建了新 ZOHO 记录

**现象：** 在"导入状态"已显示"导入成功"的行上改了内容，系统又创建了一条新 ZOHO 记录，旧记录也还在。

**原因：** 这是 v2 版本的**设计行为**，不是 BUG。

系统铁律："一行企微记录 = 一次性创建一条 ZOHO 订单"。已同步成功的行视为"历史档案"，系统永远不会再修改 ZOHO 里那条记录。任何内容变化都会被识别为"同位置新订单"，走 POST 新建流程（旧 ZOHO 记录保持不变）。

**正确用法：**
- 想改 ZOHO 订单内容 → 直接去 ZOHO 改，不要改企微
- 想新建一条 ZOHO 订单 → 在企微新增一行 或 删行后同位置重录

**为什么这样设计：** 旧版本有 PUT 更新逻辑，但企微 record_id 删除后可能复用 → DB 按 row_id 查到旧 zoho_id → PUT 会把新内容覆盖到旧 ZOHO 记录上（灾难性数据损坏）。v2 彻底移除 PUT，只用 POST 创建，数据隔离更安全。

**查看识别日志：**
```bash
grep "识别为同位置新记录" logs/app.log
```

---

### 2. 同步速度很慢

**现象：** 批量导入100条订单需要很长时间

**可能原因和解决方案：**

#### 原因1：表格行数过多
```bash
# 检查表格行数
# 建议：每个子表保持在1000行以内
# 解决：定期删除已同步成功的历史订单
```

#### 原因2：并发度配置过低
```bash
# 检查当前配置
grep ZOHO_CONCURRENCY .env

# 调整并发度
# 沙盒环境：建议 4-6
# 正式环境：建议 6-10
ZOHO_CONCURRENCY=8
```

#### 原因3：网络连接问题
```bash
# 测试ZOHO API连接
curl -w "@curl-format.txt" -o /dev/null -s https://www.zohoapis.com.cn/crm/v2/settings/modules

# 测试企微API连接
curl -w "@curl-format.txt" -o /dev/null -s https://qyapi.weixin.qq.com/cgi-bin/gettoken
```

#### 原因4：冷静期设置过长
```bash
# 如果不是点击"导入"触发，而是等待轮询
# 检查冷静期设置（默认120秒）
# 在管理界面调整为60秒
```

---

### 3. Webhook 不触发

**现象：** 点击"导入"后没有立即同步，需要等待轮询

**排查步骤：**

#### 步骤1：检查回调服务是否启动
```bash
# 查看日志
grep "\[callback\] listening" logs/app.log

# 应该看到类似输出：
# [callback] listening 127.0.0.1:8080  receiveId=ww...
```

#### 步骤2：检查企微回调配置
```bash
# 检查环境变量
grep "WECOM_CALLBACK" .env

# 必须配置：
# WECOM_CALLBACK_TOKEN=...
# WECOM_CALLBACK_AES_KEY=...
# WECOM_CALLBACK_PORT=8080
```

#### 步骤3：检查端口是否开放
```bash
# 测试端口
curl http://localhost:8080/wecom/callback

# 如果返回 404 not found，说明服务正常
# 如果连接被拒绝，说明服务未启动
```

#### 步骤4：查看回调日志
```bash
# 查看最近的回调事件
grep "\[callback\]" logs/app.log | tail -20

# 正常应该看到：
# [callback] 收到本 docid 事件 event=... user=... → 触发扫描
```

**临时解决方案：**
- Webhook 不工作时，轮询兜底机制会在60秒内处理
- 可以在管理界面点击"立即同步一次"手动触发

---

### 4. 订单确认编号冲突

**现象：** 导入状态显示"订单确认编号「XXX」在多个子表重复"

**原因：** 不同同事在不同子表中录入了相同的订单确认编号

**解决方案：**
1. 确认哪个是正确的订单
2. 修改或删除重复的订单
3. 清空"导入状态"列（触发重新同步）
4. 点击"导入"

**预防措施：**
- 建立订单编号规范（如：同事名-日期-序号）
- 定期检查冲突：
```bash
# 查看最近的冲突
grep "在多个子表重复" logs/app.log | tail -10
```

---

### 5. 必填字段校验失败

**现象：** 导入状态显示"必填为空"或"字段XXX必填"

**解决方案：**

#### 方案1：填写缺失的字段
- 在企微表格中补充必填字段
- 清空"导入状态"列
- 点击"导入"

#### 方案2：调整必填字段配置
- 访问管理界面 http://localhost:3300/
- 找到"录单必填字段"卡片
- 取消不需要必填的字段（锁定字段除外）
- 点击"保存"

**注意：** 以下字段强制必填，不可取消：
- 主题（ZOHO系统要求）
- 渠道名称（用于生成文件编号）

---

### 6. 文件编号生成失败

**现象：** 导入状态显示"文件编号生成失败"或"无法预留文件编号"等错误

**原因：** 极少见，可能是：
- 数据库损坏 / 计数器表丢失
- 并发冲突检测异常
- ZOHO Accounts 中找不到该渠道（无法解析客户编号；不再走 TMP 兜底，会直接抛错）

**解决方案：**
```bash
# 1. 检查数据库
sqlite3 data/orders_prod.db "SELECT COUNT(*) FROM sync_state WHERE file_no IS NOT NULL;"

# 2. 检查计数器
sqlite3 data/orders_prod.db "SELECT year, last_seq, seed_source, datetime(updated_at/1000,'unixepoch','localtime') FROM file_no_counter;"

# 3. 检查日志
grep -E "无法预留文件编号|无法生成文件编号|生成到已存在的文件编号" logs/app.log

# 4. 如果计数器丢失，可手工重新种子（举例 2026 年从 A0001 起步）：
sqlite3 data/orders_prod.db "INSERT OR IGNORE INTO file_no_counter (year, last_seq, seed_source, updated_at) VALUES (2026, 0, 'manual-init', $(date +%s)000);"

# 5. 如果上面都正常但仍报错，联系开发人员
```

---

### 7. ZOHO API 限流（429错误）

**现象：** 日志中出现"ZOHO API 429 Too Many Requests"

**原因：** 并发度设置过高，超过ZOHO API限制
- 沙盒环境：约 5 QPS
- 正式环境：约 10 QPS

**解决方案：**
```bash
# 降低并发度
# .env 文件
ZOHO_CONCURRENCY=4  # 沙盒
ZOHO_CONCURRENCY=6  # 正式

# 重启服务
```

---

### 8. 数据库锁定错误

**现象：** 日志中出现"database is locked"

**原因：** 多个进程同时访问数据库

**解决方案：**
```bash
# 1. 检查是否有多个实例在运行
ps aux | grep "node.*src/index.js"

# 2. 停止多余的实例
kill <PID>

# 3. 如果数据库确实锁定
# 检查是否有 .db-shm 和 .db-wal 文件
ls -la data/orders.db*

# 4. 重启服务（会自动清理）
```

---

### 9. 企微通知不发送

**现象：** 同步失败但没有收到企微通知

**排查步骤：**

#### 步骤1：检查通知开关
- 访问管理界面 http://localhost:3300/
- 查看"企微通知"卡片
- 确认开关是否开启

#### 步骤2：检查通知队列
```bash
# 查看待发送的通知
sqlite3 data/orders.db "SELECT COUNT(*) FROM notify_queue WHERE sent_at IS NULL;"

# 查看最近的通知日志
grep "\[notify\]" logs/app.log | tail -20
```

#### 步骤3：检查企微应用配置
```bash
# 检查环境变量
grep "WECOM_AGENT" .env

# 必须配置：
# WECOM_AGENT_ID=...
# WECOM_AGENT_SECRET=...
# WECOM_NOTIFY_TO=@all  # 或具体用户ID
```

---

## 性能优化建议

### 日常使用（10-50单/天）
```bash
ZOHO_CONCURRENCY=4
poll_interval_sec=60
row_cooldown_sec=120
```

### 批量导入（100-200单/次）
```bash
ZOHO_CONCURRENCY=8
poll_interval_sec=30
row_cooldown_sec=60
```

### 超大批量（500+单）
```bash
# 建议分批处理
# 方式1：分多个子表
# 方式2：分多次粘贴，每次200条
# 方式3：调整配置
POLL_MAX_ROWS=1000
ZOHO_CONCURRENCY=10
```

---

## 日志查看技巧

### 实时查看日志
```bash
tail -f logs/app.log
```

### 查看最近的错误
```bash
grep "ERROR\|error" logs/app.log | tail -20
```

### 查看特定订单的同步历史
```bash
grep "订单号XXX" logs/app.log
```

### 查看今天的同步统计
```bash
grep "本轮完成" logs/app.log | grep "$(date +%Y-%m-%d)"
```

### 查看webhook事件
```bash
grep "\[callback\]" logs/app.log | tail -50
```

---

## 紧急恢复

### 服务崩溃后重启
```bash
# 1. 检查进程
ps aux | grep "node.*src/index.js"

# 2. 如果没有运行，启动服务
npm start

# 3. 检查日志
tail -100 logs/app.log
```

### 数据库损坏
```bash
# 1. 备份当前数据库
cp data/orders.db data/orders.db.backup

# 2. 检查数据库完整性
sqlite3 data/orders.db "PRAGMA integrity_check;"

# 3. 如果损坏，尝试修复
sqlite3 data/orders.db ".recover" | sqlite3 data/orders_recovered.db

# 4. 替换数据库
mv data/orders.db data/orders.db.broken
mv data/orders_recovered.db data/orders.db

# 5. 重启服务
```

---

## 联系支持

如果以上方法都无法解决问题，请收集以下信息：

1. **错误现象描述**
2. **最近100行日志**
   ```bash
   tail -100 logs/app.log > debug.log
   ```
3. **系统配置**
   ```bash
   grep -v "SECRET\|TOKEN\|PASSWORD" .env > config.txt
   ```
4. **数据库统计**
   ```bash
   sqlite3 data/orders.db "SELECT status, COUNT(*) FROM sync_state GROUP BY status;" > db_stats.txt
   ```

然后联系开发人员进行进一步诊断。
