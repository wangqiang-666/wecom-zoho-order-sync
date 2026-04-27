# 部署指南 - 字段修改更新

## 修改内容总结

本次修改涉及3个需求：
1. **需求1**：企微"10订单金额" → ZOHO field20（原币订单金额）+ field218（人民币快递金额）
2. **需求2**：企微"业务员"（原名"订单导入者"）→ ZOHO field8（原来field223）
3. **需求3**：插入时默认 field62（订单状态）= "正常"

## 修改的文件清单

### 核心代码（必须同步）
1. `config/field-map.json` - 字段映射配置
2. `src/mappers/value-transform.js` - 默认值逻辑

### 文档（可选同步）
3. `docs/FIELD_MAPPING.md`
4. `docs/zoho-required-fields-comparison.md`

### 测试脚本（可选同步）
5. `scripts/test-value-transform.js`
6. `scripts/test-zoho-required-fields.js`
7. 其他6个测试脚本

---

## 部署步骤

### 步骤1：确认Tailscale连接

```bash
# 检查Tailscale状态
tailscale status | grep inotary-svr-1

# 如果未连接，启动Tailscale
# macOS: 打开Tailscale应用
```

### 步骤2：备份远程服务器当前代码

```bash
# SSH连接到服务器
ssh -o IdentityFile=~/.ssh/id_ed25519 -o IdentitiesOnly=yes inotary2024@100.68.34.25

# 进入项目目录（请根据实际路径调整）
cd ~/wecom-zoho-order-sync  # 或者实际的项目路径

# 创建备份
cp -r . ../wecom-zoho-order-sync-backup-$(date +%Y%m%d-%H%M%S)

# 或者使用git备份当前状态
git add -A
git commit -m "backup before field changes $(date +%Y%m%d-%H%M%S)"
```

### 步骤3：同步修改的文件到服务器

**方案A：使用SCP上传（推荐）**

```bash
# 在本地执行，上传核心文件
cd /Users/yyzinotary/Documents/wecom-zoho-order-sync

# 上传field-map.json
scp -i ~/.ssh/id_ed25519 \
  config/field-map.json \
  inotary2024@100.68.34.25:~/wecom-zoho-order-sync/config/

# 上传value-transform.js
scp -i ~/.ssh/id_ed25519 \
  src/mappers/value-transform.js \
  inotary2024@100.68.34.25:~/wecom-zoho-order-sync/src/mappers/

# 可选：上传文档
scp -i ~/.ssh/id_ed25519 \
  docs/FIELD_MAPPING.md \
  docs/zoho-required-fields-comparison.md \
  inotary2024@100.68.34.25:~/wecom-zoho-order-sync/docs/
```

**方案B：使用Git同步（如果服务器有Git仓库）**

```bash
# 在本地提交修改
cd /Users/yyzinotary/Documents/wecom-zoho-order-sync
git add config/field-map.json src/mappers/value-transform.js
git commit -m "feat: 字段修改 - 业务员(field8) + field218 + field62默认值"
git push

# SSH到服务器拉取
ssh -o IdentityFile=~/.ssh/id_ed25519 -o IdentitiesOnly=yes inotary2024@100.68.34.25 \
  "cd ~/wecom-zoho-order-sync && git pull"
```

### 步骤4：验证文件已更新

```bash
# SSH到服务器
ssh -o IdentityFile=~/.ssh/id_ed25519 -o IdentitiesOnly=yes inotary2024@100.68.34.25

# 验证field-map.json
cd ~/wecom-zoho-order-sync
grep "业务员" config/field-map.json
# 应该看到：{ "source": "业务员", "target": "field8", ...

# 验证value-transform.js
grep "field218" src/mappers/value-transform.js
grep "field62" src/mappers/value-transform.js
# 应该看到相关的赋值逻辑
```

### 步骤5：重启Docker容器

```bash
# 方案A：如果使用docker compose
ssh -o IdentityFile=~/.ssh/id_ed25519 -o IdentitiesOnly=yes inotary2024@100.68.34.25 \
  "export PATH=\$PATH:/usr/local/bin:/opt/homebrew/bin:~/.orbstack/bin && \
   cd ~/wecom-zoho-order-sync && \
   docker compose restart"

# 方案B：如果是单独的docker容器
ssh -o IdentityFile=~/.ssh/id_ed25519 -o IdentitiesOnly=yes inotary2024@100.68.34.25 \
  "export PATH=\$PATH:/usr/local/bin:/opt/homebrew/bin:~/.orbstack/bin && \
   docker restart wecom-zoho-order-sync"

# 方案C：完全重建（如果需要）
ssh -o IdentityFile=~/.ssh/id_ed25519 -o IdentitiesOnly=yes inotary2024@100.68.34.25 \
  "export PATH=\$PATH:/usr/local/bin:/opt/homebrew/bin:~/.orbstack/bin && \
   cd ~/wecom-zoho-order-sync && \
   docker compose down && \
   docker compose up -d"
```

### 步骤6：检查服务状态

```bash
# 查看容器日志
ssh -o IdentityFile=~/.ssh/id_ed25519 -o IdentitiesOnly=yes inotary2024@100.68.34.25 \
  "export PATH=\$PATH:/usr/local/bin:/opt/homebrew/bin:~/.orbstack/bin && \
   docker compose logs -f --tail=50"

# 检查配置是否加载成功
# 日志中应该看到：
# ✓ field-map 共 39 个字段
# ✓ config 加载成功
```

### 步骤7：访问管理界面验证

```bash
# 打开浏览器访问管理界面
# http://100.68.34.25:3300

# 检查"录单必填字段"部分
# 应该看到：业务员 → field8 ☑️
# （原来是：订单导入者 → field223）
```

---

## ⚠️ 重要提醒

### 1. 企微表格列名必须同步修改

**在部署到正式环境前，必须先修改企微表格：**
- 把"订单导入者"列改名为"业务员"
- 否则同步会失败（找不到"业务员"列）

### 2. 测试流程

**建议在沙盒环境测试：**

```bash
# 1. 确认当前是沙盒环境
ssh -o IdentityFile=~/.ssh/id_ed25519 -o IdentitiesOnly=yes inotary2024@100.68.34.25 \
  "cd ~/wecom-zoho-order-sync && grep ZOHO_ENV .env"
# 应该看到：ZOHO_ENV=sandbox

# 2. 测试1-2条数据
# 在企微表格中填写测试订单，选择"导入"

# 3. 检查ZOHO沙盒
# 验证：
#   - field8（业务员）有值
#   - field218（人民币快递金额）= field20（原币订单金额）
#   - field62（订单状态）= "正常"
```

### 3. 切换到正式环境

**只有在沙盒测试通过后才切换：**

```bash
# 修改.env文件
ssh -o IdentityFile=~/.ssh/id_ed25519 -o IdentitiesOnly=yes inotary2024@100.68.34.25

cd ~/wecom-zoho-order-sync
# 备份当前.env
cp .env .env.backup

# 修改ZOHO_ENV
sed -i '' 's/ZOHO_ENV=sandbox/ZOHO_ENV=production/' .env

# 重启服务
docker compose restart

# 确认环境
docker compose logs | grep "正式环境"
# 应该看到：🔴 正式环境 (PRODUCTION)
```

---

## 回滚方案

如果部署后出现问题：

```bash
# SSH到服务器
ssh -o IdentityFile=~/.ssh/id_ed25519 -o IdentitiesOnly=yes inotary2024@100.68.34.25

# 恢复备份
cd ~
rm -rf wecom-zoho-order-sync
mv wecom-zoho-order-sync-backup-YYYYMMDD-HHMMSS wecom-zoho-order-sync

# 重启容器
cd wecom-zoho-order-sync
docker compose restart
```

---

## 常见问题

### Q1: 如何确认项目路径？

```bash
ssh -o IdentityFile=~/.ssh/id_ed25519 -o IdentitiesOnly=yes inotary2024@100.68.34.25 \
  "find ~ -name 'wecom-zoho-order-sync' -type d 2>/dev/null"
```

### Q2: 如何查看Docker容器名？

```bash
ssh -o IdentityFile=~/.ssh/id_ed25519 -o IdentitiesOnly=yes inotary2024@100.68.34.25 \
  "export PATH=\$PATH:/usr/local/bin:/opt/homebrew/bin:~/.orbstack/bin && docker ps"
```

### Q3: 如何验证修改生效？

```bash
# 方法1：检查日志
docker compose logs | grep "field-map 共"
# 应该看到：✓ field-map 共 39 个字段

# 方法2：进入容器验证
docker compose exec app node -e "
const config = require('./src/config.js');
const f = config.fieldMap.fields.find(f => f.source === '业务员');
console.log('业务员字段:', f ? 'target=' + f.target : '未找到');
"
# 应该输出：业务员字段: target=field8
```

---

## 联系信息

如有问题，请检查：
1. 服务器日志：`docker compose logs -f`
2. 管理界面：http://100.68.34.25:3300
3. 企微表格列名是否已改为"业务员"
