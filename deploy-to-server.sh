#!/bin/bash
# 部署脚本 - 同步代码到远程服务器并重启

set -e  # 遇到错误立即退出

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  部署 wecom-zoho-order-sync${NC}"
echo -e "${GREEN}========================================${NC}"

# 配置
REMOTE_USER="inotary2024"
REMOTE_HOST="100.68.34.25"
SSH_KEY="~/.ssh/id_ed25519"
LOCAL_PROJECT="/Users/yyzinotary/Documents/wecom-zoho-order-sync"
REMOTE_PROJECT="~/wecom-zoho-order-sync"

# SSH命令前缀
SSH_CMD="ssh -o IdentityFile=$SSH_KEY -o IdentitiesOnly=yes $REMOTE_USER@$REMOTE_HOST"

echo ""
echo -e "${YELLOW}步骤1: 检查SSH连接...${NC}"
if $SSH_CMD "echo '✓ SSH连接成功'"; then
    echo -e "${GREEN}✓ SSH连接正常${NC}"
else
    echo -e "${RED}✗ SSH连接失败，请检查Tailscale是否连接${NC}"
    exit 1
fi

echo ""
echo -e "${YELLOW}步骤2: 查找远程项目路径...${NC}"
REMOTE_PATH=$($SSH_CMD "find ~ -name 'wecom-zoho-order-sync' -type d 2>/dev/null | head -1")
if [ -z "$REMOTE_PATH" ]; then
    echo -e "${RED}✗ 未找到项目目录，请手动指定${NC}"
    exit 1
fi
echo -e "${GREEN}✓ 找到项目: $REMOTE_PATH${NC}"

echo ""
echo -e "${YELLOW}步骤3: 备份远程代码...${NC}"
BACKUP_NAME="backup-$(date +%Y%m%d-%H%M%S)"
$SSH_CMD "cd $REMOTE_PATH && cp config/field-map.json config/field-map.json.$BACKUP_NAME && cp src/mappers/value-transform.js src/mappers/value-transform.js.$BACKUP_NAME"
echo -e "${GREEN}✓ 已备份关键文件${NC}"

echo ""
echo -e "${YELLOW}步骤4: 上传修改的文件...${NC}"

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

# 上传文档（可选）
echo "  上传文档..."
scp -i $SSH_KEY \
    "$LOCAL_PROJECT/docs/FIELD_MAPPING.md" \
    "$LOCAL_PROJECT/docs/zoho-required-fields-comparison.md" \
    "$REMOTE_USER@$REMOTE_HOST:$REMOTE_PATH/docs/" 2>/dev/null || true

echo -e "${GREEN}✓ 文件上传完成${NC}"

echo ""
echo -e "${YELLOW}步骤5: 验证文件内容...${NC}"
echo "  检查 field-map.json..."
if $SSH_CMD "cd $REMOTE_PATH && grep -q '业务员' config/field-map.json && grep -q 'field8' config/field-map.json"; then
    echo -e "${GREEN}  ✓ field-map.json 已更新（业务员 → field8）${NC}"
else
    echo -e "${RED}  ✗ field-map.json 验证失败${NC}"
    exit 1
fi

echo "  检查 value-transform.js..."
if $SSH_CMD "cd $REMOTE_PATH && grep -q 'field218' src/mappers/value-transform.js && grep -q 'field62' src/mappers/value-transform.js"; then
    echo -e "${GREEN}  ✓ value-transform.js 已更新（field218 + field62）${NC}"
else
    echo -e "${RED}  ✗ value-transform.js 验证失败${NC}"
    exit 1
fi

echo ""
echo -e "${YELLOW}步骤6: 查找Docker容器...${NC}"
CONTAINER_INFO=$($SSH_CMD "export PATH=\$PATH:/usr/local/bin:/opt/homebrew/bin:~/.orbstack/bin && docker ps --format '{{.Names}}\t{{.Status}}' | grep -i zoho || echo ''")
if [ -z "$CONTAINER_INFO" ]; then
    echo -e "${YELLOW}  未找到运行中的容器，尝试查找所有容器...${NC}"
    CONTAINER_INFO=$($SSH_CMD "export PATH=\$PATH:/usr/local/bin:/opt/homebrew/bin:~/.orbstack/bin && docker ps -a --format '{{.Names}}\t{{.Status}}' | grep -i zoho || echo ''")
fi

if [ -z "$CONTAINER_INFO" ]; then
    echo -e "${RED}  ✗ 未找到Docker容器${NC}"
    echo -e "${YELLOW}  请手动重启服务${NC}"
    exit 1
fi

echo -e "${GREEN}  ✓ 找到容器:${NC}"
echo "$CONTAINER_INFO" | while read line; do
    echo "    $line"
done

echo ""
echo -e "${YELLOW}步骤7: 重启Docker容器...${NC}"

# 尝试使用docker compose
if $SSH_CMD "cd $REMOTE_PATH && test -f docker-compose.yml"; then
    echo "  使用 docker compose restart..."
    $SSH_CMD "export PATH=\$PATH:/usr/local/bin:/opt/homebrew/bin:~/.orbstack/bin && cd $REMOTE_PATH && docker compose restart"
    echo -e "${GREEN}✓ Docker容器已重启（docker compose）${NC}"
else
    # 尝试直接重启容器
    CONTAINER_NAME=$(echo "$CONTAINER_INFO" | head -1 | awk '{print $1}')
    echo "  使用 docker restart $CONTAINER_NAME..."
    $SSH_CMD "export PATH=\$PATH:/usr/local/bin:/opt/homebrew/bin:~/.orbstack/bin && docker restart $CONTAINER_NAME"
    echo -e "${GREEN}✓ Docker容器已重启${NC}"
fi

echo ""
echo -e "${YELLOW}步骤8: 等待服务启动...${NC}"
sleep 5

echo ""
echo -e "${YELLOW}步骤9: 检查服务日志...${NC}"
echo -e "${GREEN}最近的日志:${NC}"
if $SSH_CMD "cd $REMOTE_PATH && test -f docker-compose.yml"; then
    $SSH_CMD "export PATH=\$PATH:/usr/local/bin:/opt/homebrew/bin:~/.orbstack/bin && cd $REMOTE_PATH && docker compose logs --tail=20" | tail -20
else
    CONTAINER_NAME=$(echo "$CONTAINER_INFO" | head -1 | awk '{print $1}')
    $SSH_CMD "export PATH=\$PATH:/usr/local/bin:/opt/homebrew/bin:~/.orbstack/bin && docker logs --tail=20 $CONTAINER_NAME" | tail -20
fi

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  部署完成！${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${YELLOW}后续步骤:${NC}"
echo "1. 访问管理界面: http://100.68.34.25:3300"
echo "2. 检查「录单必填字段」是否显示: 业务员 → field8"
echo "3. 在企微表格中把「订单导入者」列改名为「业务员」"
echo "4. 在沙盒环境测试1-2条数据"
echo "5. 验证ZOHO中的字段:"
echo "   - field8（业务员）有值"
echo "   - field218（人民币快递金额）= field20"
echo "   - field62（订单状态）= 正常"
echo ""
echo -e "${YELLOW}回滚命令（如需要）:${NC}"
echo "ssh -i $SSH_KEY $REMOTE_USER@$REMOTE_HOST \"cd $REMOTE_PATH && cp config/field-map.json.$BACKUP_NAME config/field-map.json && cp src/mappers/value-transform.js.$BACKUP_NAME src/mappers/value-transform.js && docker compose restart\""
echo ""
