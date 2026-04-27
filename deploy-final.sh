#!/bin/bash
# 最终部署脚本 - 包含所有修改

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  最终部署 - 所有修改${NC}"
echo -e "${GREEN}========================================${NC}"

REMOTE_USER="inotary2024"
REMOTE_HOST="100.68.34.25"
SSH_KEY="~/.ssh/id_ed25519"
LOCAL_PROJECT="/Users/yyzinotary/Documents/wecom-zoho-order-sync"

SSH_CMD="ssh -o IdentityFile=$SSH_KEY -o IdentitiesOnly=yes $REMOTE_USER@$REMOTE_HOST"

echo ""
echo -e "${YELLOW}步骤1: 检查SSH连接...${NC}"
if $SSH_CMD "echo '✓ SSH连接成功'"; then
    echo -e "${GREEN}✓ SSH连接正常${NC}"
else
    echo -e "${RED}✗ SSH连接失败${NC}"
    exit 1
fi

echo ""
echo -e "${YELLOW}步骤2: 查找远程项目路径...${NC}"
REMOTE_PATH=$($SSH_CMD "find ~ -name 'wecom-zoho-order-sync' -type d 2>/dev/null | head -1")
if [ -z "$REMOTE_PATH" ]; then
    echo -e "${RED}✗ 未找到项目目录${NC}"
    exit 1
fi
echo -e "${GREEN}✓ 项目: $REMOTE_PATH${NC}"

echo ""
echo -e "${YELLOW}步骤3: 备份远程代码...${NC}"
BACKUP_NAME="backup-$(date +%Y%m%d-%H%M%S)"
$SSH_CMD "cd $REMOTE_PATH && \
  cp config/field-map.json config/field-map.json.$BACKUP_NAME && \
  cp src/mappers/value-transform.js src/mappers/value-transform.js.$BACKUP_NAME && \
  cp src/services/admin-server.js src/services/admin-server.js.$BACKUP_NAME"
echo -e "${GREEN}✓ 已备份: $BACKUP_NAME${NC}"

echo ""
echo -e "${YELLOW}步骤4: 上传修改的文件...${NC}"

echo "  上传 config/field-map.json..."
scp -i $SSH_KEY \
    "$LOCAL_PROJECT/config/field-map.json" \
    "$REMOTE_USER@$REMOTE_HOST:$REMOTE_PATH/config/"

echo "  上传 src/mappers/value-transform.js..."
scp -i $SSH_KEY \
    "$LOCAL_PROJECT/src/mappers/value-transform.js" \
    "$REMOTE_USER@$REMOTE_HOST:$REMOTE_PATH/src/mappers/"

echo "  上传 src/services/admin-server.js..."
scp -i $SSH_KEY \
    "$LOCAL_PROJECT/src/services/admin-server.js" \
    "$REMOTE_USER@$REMOTE_HOST:$REMOTE_PATH/src/services/"

echo "  上传文档..."
scp -i $SSH_KEY \
    "$LOCAL_PROJECT/docs/FIELD_MAPPING.md" \
    "$LOCAL_PROJECT/docs/zoho-required-fields-comparison.md" \
    "$REMOTE_USER@$REMOTE_HOST:$REMOTE_PATH/docs/" 2>/dev/null || true

echo -e "${GREEN}✓ 文件上传完成${NC}"

echo ""
echo -e "${YELLOW}步骤5: 验证修改...${NC}"

echo "  检查 field-map.json..."
if $SSH_CMD "cd $REMOTE_PATH && grep -q '\"业务员\".*\"field8\".*\"ownerlookup\"' config/field-map.json"; then
    echo -e "${GREEN}  ✓ 业务员 → field8 (ownerlookup)${NC}"
else
    echo -e "${RED}  ✗ field-map.json 验证失败${NC}"
    exit 1
fi

echo "  检查 value-transform.js..."
if $SSH_CMD "cd $REMOTE_PATH && grep -q 'field218' src/mappers/value-transform.js && grep -q 'field62' src/mappers/value-transform.js && grep -q 'payload\[spec.target\]' src/mappers/value-transform.js"; then
    echo -e "${GREEN}  ✓ field218 + field62 + 通用用户查找${NC}"
else
    echo -e "${RED}  ✗ value-transform.js 验证失败${NC}"
    exit 1
fi

echo "  检查 admin-server.js..."
if $SSH_CMD "cd $REMOTE_PATH && grep -q 'saveCooldown' src/services/admin-server.js && grep -q 'env-badge' src/services/admin-server.js"; then
    echo -e "${GREEN}  ✓ 冷静期UI + 环境标识已添加${NC}"
else
    echo -e "${RED}  ✗ admin-server.js 验证失败${NC}"
    exit 1
fi

echo ""
echo -e "${YELLOW}步骤6: 重启Docker容器...${NC}"
if $SSH_CMD "cd $REMOTE_PATH && test -f docker-compose.yml"; then
    $SSH_CMD "export PATH=\$PATH:/usr/local/bin:/opt/homebrew/bin:~/.orbstack/bin && cd $REMOTE_PATH && docker compose restart"
    echo -e "${GREEN}✓ 容器已重启（docker compose）${NC}"
else
    CONTAINER=$($SSH_CMD "export PATH=\$PATH:/usr/local/bin:/opt/homebrew/bin:~/.orbstack/bin && docker ps --format '{{.Names}}' | grep -i zoho | head -1")
    $SSH_CMD "export PATH=\$PATH:/usr/local/bin:/opt/homebrew/bin:~/.orbstack/bin && docker restart $CONTAINER"
    echo -e "${GREEN}✓ 容器已重启${NC}"
fi

echo ""
echo -e "${YELLOW}步骤7: 等待服务启动...${NC}"
sleep 5

echo ""
echo -e "${YELLOW}步骤8: 检查服务日志...${NC}"
if $SSH_CMD "cd $REMOTE_PATH && test -f docker-compose.yml"; then
    $SSH_CMD "export PATH=\$PATH:/usr/local/bin:/opt/homebrew/bin:~/.orbstack/bin && cd $REMOTE_PATH && docker compose logs --tail=20" | tail -20
fi

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  部署完成！${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${YELLOW}修改内容总结:${NC}"
echo "1. field-map.json: 业务员 → field8 (ownerlookup)"
echo "2. value-transform.js:"
echo "   - field218 (人民币快递金额) = field20 (原币订单金额)"
echo "   - field62 (订单状态) = \"正常\""
echo "   - 支持通用用户查找字段"
echo "3. admin-server.js:"
echo "   - 添加环境标识（沙盒/正式）"
echo "   - 添加录入冷静期UI（⚡实时性关键）"
echo "   - 添加轮询间隔UI"
echo ""
echo -e "${YELLOW}⚡ 重要配置建议:${NC}"
echo "1. 访问管理界面: http://100.68.34.25:3300"
echo "2. 【关键】设置录入冷静期为 10-15秒（实现快速同步）"
echo "3. 设置轮询间隔为 60秒（兜底）"
echo "4. 检查环境标识是否正确显示"
echo ""
echo -e "${YELLOW}测试步骤:${NC}"
echo "1. 在企微表格填写测试数据"
echo "2. 点击「是否确定导入」选择「导入」"
echo "3. 等待约 13-18秒（冷静期10秒 + webhook 3秒）"
echo "4. 检查ZOHO中的字段:"
echo "   - field8 (业务员) 有用户ID"
echo "   - field218 (人民币快递金额) = field20"
echo "   - field62 (订单状态) = 正常"
echo ""
echo -e "${YELLOW}回滚命令（如需要）:${NC}"
echo "ssh -i $SSH_KEY $REMOTE_USER@$REMOTE_HOST \"cd $REMOTE_PATH && \\"
echo "  cp config/field-map.json.$BACKUP_NAME config/field-map.json && \\"
echo "  cp src/mappers/value-transform.js.$BACKUP_NAME src/mappers/value-transform.js && \\"
echo "  cp src/services/admin-server.js.$BACKUP_NAME src/services/admin-server.js && \\"
echo "  docker compose restart\""
echo ""
