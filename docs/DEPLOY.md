# Mac mini 部署指南

## 前置条件
- macOS 上已安装 Node.js ≥ 20（推荐 `brew install node`）
- 已完成 `.env` 配置（凭证 + 同步账号邮箱）
- 已跑过 `npm run dry-run` 无异常

## 一、初始化
```bash
cd ~/Documents/wecom-zoho-order-sync
npm install
cp .env.example .env
# 编辑 .env
npm run pull-meta   # 校验字段映射
npm run dry-run     # 校验本地 xlsx 样本
```

## 二、launchd 开机自启

### 1. 把 plist 放到用户级 LaunchAgents
```bash
mkdir -p ~/Library/LaunchAgents
cp scripts/com.inotary.wecom-zoho-sync.plist ~/Library/LaunchAgents/
```

### 2. 按实际路径改 plist
打开 `~/Library/LaunchAgents/com.inotary.wecom-zoho-sync.plist`，确认以下三处：
- `ProgramArguments`：`node` 的绝对路径（`which node` 查）、`src/index.js` 的绝对路径
- `WorkingDirectory`：项目根目录绝对路径
- `StandardOutPath` / `StandardErrorPath`：日志路径

### 3. 加载并启动
```bash
launchctl load  ~/Library/LaunchAgents/com.inotary.wecom-zoho-sync.plist
launchctl start com.inotary.wecom-zoho-sync
```

### 4. 常用命令
```bash
# 查看是否在跑
launchctl list | grep wecom-zoho-sync

# 重启（改了 .env 或代码后）
launchctl unload ~/Library/LaunchAgents/com.inotary.wecom-zoho-sync.plist
launchctl load   ~/Library/LaunchAgents/com.inotary.wecom-zoho-sync.plist

# 看实时日志
tail -f logs/sync.log
tail -f logs/stdout.log

# 健康检查
curl http://127.0.0.1:3300/health
```

## 三、崩溃自动拉起
plist 里设置了 `KeepAlive=true`，进程崩溃 launchd 会自动重启。

## 四、升级流程
```bash
git pull
npm install
launchctl unload ~/Library/LaunchAgents/com.inotary.wecom-zoho-sync.plist
launchctl load   ~/Library/LaunchAgents/com.inotary.wecom-zoho-sync.plist
```

## 五、同事接手时看什么
1. 本文档
2. `docs/ARCHITECTURE.md` —— 架构
3. `docs/FIELD_MAPPING.md` —— 字段对照
4. `logs/sync.log` —— 运行日志
5. 企微 @云易证小智 应用的消息历史 —— 失败事件
