#!/bin/bash
# 检查服务器当前环境

set -e

REMOTE_USER="inotary2024"
REMOTE_HOST="100.68.34.25"
SSH_KEY="~/.ssh/id_ed25519"

SSH_CMD="ssh -o IdentityFile=$SSH_KEY -o IdentitiesOnly=yes $REMOTE_USER@$REMOTE_HOST"

echo "=========================================="
echo "  检查服务器当前环境"
echo "=========================================="
echo ""

echo "查找项目路径..."
REMOTE_PATH=$($SSH_CMD "find ~ -name 'wecom-zoho-order-sync' -type d 2>/dev/null | head -1")
echo "✓ 项目: $REMOTE_PATH"
echo ""

echo "检查 .env 配置..."
echo "----------------------------------------"
$SSH_CMD "cd $REMOTE_PATH && grep -E 'ZOHO_ENV|ZOHO_API_BASE_URL' .env | head -10"
echo "----------------------------------------"
echo ""

echo "检查容器日志中的环境信息..."
echo "----------------------------------------"
if $SSH_CMD "cd $REMOTE_PATH && test -f docker-compose.yml"; then
    $SSH_CMD "export PATH=\$PATH:/usr/local/bin:/opt/homebrew/bin:~/.orbstack/bin && cd $REMOTE_PATH && docker compose logs | grep -E '沙盒|sandbox|正式|production|ZOHO.*环境' | tail -5"
else
    CONTAINER=$($SSH_CMD "export PATH=\$PATH:/usr/local/bin:/opt/homebrew/bin:~/.orbstack/bin && docker ps --format '{{.Names}}' | grep -i zoho | head -1")
    $SSH_CMD "export PATH=\$PATH:/usr/local/bin:/opt/homebrew/bin:~/.orbstack/bin && docker logs $CONTAINER 2>&1 | grep -E '沙盒|sandbox|正式|production|ZOHO.*环境' | tail -5"
fi
echo "----------------------------------------"
echo ""

echo "=========================================="
echo "  检查完成"
echo "=========================================="
