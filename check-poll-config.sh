#!/bin/bash
# 检查服务器当前的轮询配置

set -e

REMOTE_USER="inotary2024"
REMOTE_HOST="100.68.34.25"
SSH_KEY="~/.ssh/id_ed25519"

SSH_CMD="ssh -o IdentityFile=$SSH_KEY -o IdentitiesOnly=yes $REMOTE_USER@$REMOTE_HOST"

echo "=========================================="
echo "  检查轮询配置"
echo "=========================================="
echo ""

echo "查找项目路径..."
REMOTE_PATH=$($SSH_CMD "find ~ -name 'wecom-zoho-order-sync' -type d 2>/dev/null | head -1")
echo "✓ 项目: $REMOTE_PATH"
echo ""

echo "检查数据库配置..."
$SSH_CMD "cd $REMOTE_PATH && sqlite3 data/orders.db 'SELECT key, value FROM app_config WHERE key IN (\"poll_interval_sec\", \"row_cooldown_sec\", \"notify_enabled\");'" || echo "数据库查询失败"
echo ""

echo "检查 .env 配置..."
$SSH_CMD "cd $REMOTE_PATH && grep -E 'POLL_INTERVAL|ZOHO_ENV' .env | head -5" || echo ".env 读取失败"
echo ""

echo "检查容器日志中的轮询信息..."
if $SSH_CMD "cd $REMOTE_PATH && test -f docker-compose.yml"; then
    $SSH_CMD "export PATH=\$PATH:/usr/local/bin:/opt/homebrew/bin:~/.orbstack/bin && cd $REMOTE_PATH && docker compose logs | grep -E '轮询|poll' | tail -10"
else
    CONTAINER=$($SSH_CMD "export PATH=\$PATH:/usr/local/bin:/opt/homebrew/bin:~/.orbstack/bin && docker ps --format '{{.Names}}' | grep -i zoho | head -1")
    $SSH_CMD "export PATH=\$PATH:/usr/local/bin:/opt/homebrew/bin:~/.orbstack/bin && docker logs $CONTAINER 2>&1 | grep -E '轮询|poll' | tail -10"
fi
echo ""

echo "=========================================="
echo "  检查完成"
echo "=========================================="
echo ""
echo "如需修改轮询间隔，访问管理界面："
echo "http://100.68.34.25:3300"
echo ""
echo "或者直接修改数据库："
echo "sqlite3 data/orders.db \"UPDATE app_config SET value='15' WHERE key='poll_interval_sec';\""
