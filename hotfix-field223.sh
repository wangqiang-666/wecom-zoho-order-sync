#!/bin/bash
# 紧急修复 - field8 用户查找类型

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${RED}========================================${NC}"
echo -e "${RED}  紧急修复：field8 用户查找类型${NC}"
echo -e "${RED}========================================${NC}"

REMOTE_USER="inotary2024"
REMOTE_HOST="100.68.34.25"
SSH_KEY="~/.ssh/id_ed25519"
LOCAL_PROJECT="/Users/yyzinotary/Documents/wecom-zoho-order-sync"

SSH_CMD="ssh -o IdentityFile=$SSH_KEY -o IdentitiesOnly=yes $REMOTE_USER@$REMOTE_HOST"

echo ""
echo -e "${YELLOW}查找远程项目路径...${NC}"
REMOTE_PATH=$($SSH_CMD "find ~ -name 'wecom-zoho-order-sync' -type d 2>/dev/null | head -1")
echo -e "${GREEN}✓ 项目路径: $REMOTE_PATH${NC}"

echo ""
echo -e "${YELLOW}上传修复后的文件...${NC}"

# 上传 field-map.json
echo "  上传 config/field-map.json..."
scp -i $SSH_KEY \
    "$LOCAL_PROJECT/config/field-map.json" \
    "$REMOTE_USER@$REMOTE_HOST:$REMOTE_PATH/config/"

# 上传 value-transform.js
echo "  上传 src/mappers/value-transform.js..."
scp -i $SSH_KEY \
    "$LOCAL_PROJECT/src/mappers/value-transform.js" \
    "$REMOTE_USER@$REMOTE_HOST:$REMOTE_PATH/src/mappers/"

echo -e "${GREEN}✓ 文件已上传${NC}"

echo ""
echo -e "${YELLOW}验证修复...${NC}"
if $SSH_CMD "cd $REMOTE_PATH && grep -q '\"业务员\".*\"field8\".*\"ownerlookup\"' config/field-map.json"; then
    echo -e "${GREEN}✓ field-map.json: 业务员 → field8 (ownerlookup)${NC}"
else
    echo -e "${RED}✗ field-map.json 验证失败${NC}"
    exit 1
fi

if $SSH_CMD "cd $REMOTE_PATH && grep -q 'payload\[spec.target\]' src/mappers/value-transform.js"; then
    echo -e "${GREEN}✓ value-transform.js: 支持通用用户查找${NC}"
else
    echo -e "${RED}✗ value-transform.js 验证失败${NC}"
    exit 1
fi

echo ""
echo -e "${YELLOW}重启Docker容器...${NC}"
if $SSH_CMD "cd $REMOTE_PATH && test -f docker-compose.yml"; then
    $SSH_CMD "export PATH=\$PATH:/usr/local/bin:/opt/homebrew/bin:~/.orbstack/bin && cd $REMOTE_PATH && docker compose restart"
else
    CONTAINER=$($SSH_CMD "export PATH=\$PATH:/usr/local/bin:/opt/homebrew/bin:~/.orbstack/bin && docker ps --format '{{.Names}}' | grep -i zoho | head -1")
    $SSH_CMD "export PATH=\$PATH:/usr/local/bin:/opt/homebrew/bin:~/.orbstack/bin && docker restart $CONTAINER"
fi
echo -e "${GREEN}✓ 容器已重启${NC}"

echo ""
echo -e "${YELLOW}等待服务启动...${NC}"
sleep 5

echo ""
echo -e "${YELLOW}检查日志...${NC}"
if $SSH_CMD "cd $REMOTE_PATH && test -f docker-compose.yml"; then
    $SSH_CMD "export PATH=\$PATH:/usr/local/bin:/opt/homebrew/bin:~/.orbstack/bin && cd $REMOTE_PATH && docker compose logs --tail=15" | tail -15
fi

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  修复完成！${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${YELLOW}修复内容:${NC}"
echo "1. field-map.json: 业务员 → field8 (type: ownerlookup)"
echo "2. value-transform.js: 支持通用用户查找字段"
echo ""
echo -e "${YELLOW}现在可以重新测试了${NC}"
echo "企微表格「业务员」列填写姓名（如：张三），系统会自动反查ZOHO用户ID"

