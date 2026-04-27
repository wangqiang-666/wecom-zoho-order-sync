#!/bin/bash
# 本地沙盒测试脚本

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  本地沙盒环境测试${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""

echo -e "${YELLOW}1. 检查环境配置...${NC}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if grep -q "ZOHO_ENV=sandbox" .env; then
    echo -e "${GREEN}✓ 已切换到沙盒环境${NC}"
else
    echo -e "${RED}✗ 当前不是沙盒环境！${NC}"
    echo "请确认 .env 中 ZOHO_ENV=sandbox"
    exit 1
fi

echo ""
echo -e "${YELLOW}2. 验证代码修改...${NC}"

# 检查 field-map.json
if grep -q '"业务员".*"field8".*"ownerlookup"' config/field-map.json; then
    echo -e "${GREEN}✓ field-map.json: 业务员 → field8 (ownerlookup)${NC}"
else
    echo -e "${RED}✗ field-map.json 配置错误${NC}"
    exit 1
fi

# 检查 value-transform.js
if grep -q 'field218' src/mappers/value-transform.js && grep -q 'field62' src/mappers/value-transform.js; then
    echo -e "${GREEN}✓ value-transform.js: field218 + field62 已添加${NC}"
else
    echo -e "${RED}✗ value-transform.js 修改缺失${NC}"
    exit 1
fi

if grep -q 'payload\[spec.target\]' src/mappers/value-transform.js; then
    echo -e "${GREEN}✓ value-transform.js: 支持通用用户查找${NC}"
else
    echo -e "${RED}✗ value-transform.js 用户查找逻辑缺失${NC}"
    exit 1
fi

echo ""
echo -e "${YELLOW}3. 运行集成测试...${NC}"
node -e "
const config = require('./src/config.js');
const { transformRow } = require('./src/mappers/value-transform.js');

const rawRow = {
  '10订单金额': '600',
  '业务员': 'Erik',
  '主题': '测试订单',
  '订单日期': '2026-04-27',
  '公证主体中文名': '测试公司',
  '文件存放路径': '/test',
  '业务细类': '测试',
  '1公证书使用地': '香港',
  '9附件数量': '5',
  '供应商': '谢律师',
  '文案': '测试',
  '删除不负责证词': '是',
  '其他注意事项': '无',
  '需递交文件名': 'test',
  '总页数': '10',
  '彩打页数': '5',
  '渠道名称': '测试',
  '订单所有者': 'Admin'
};

async function test() {
  const result = await transformRow({
    rawRow,
    fieldMap: config.fieldMap,
    defaultOwnerId: 'DEFAULT_OWNER_ID',
    currency: 'RMB',
    lookupResolver: async () => 'LOOKUP_ID',
    userResolver: async (name) => {
      console.log('  ✓ 用户反查:', name);
      return 'USER_' + name;
    }
  });

  if (!result.ok) {
    console.error('❌ 转换失败:', JSON.stringify(result.errors, null, 2));
    process.exit(1);
  }

  console.log('');
  console.log('✓ 转换成功');
  console.log('');
  console.log('关键字段验证:');
  console.log('  field20 (原币订单金额):', result.payload.field20);
  console.log('  field218 (人民币快递金额):', result.payload.field218);
  console.log('  field62 (订单状态):', result.payload.field62);
  console.log('  field8 (业务员):', JSON.stringify(result.payload.field8));
  console.log('  Owner (订单所有者):', JSON.stringify(result.payload.Owner));
  console.log('');

  // 验证
  const errors = [];
  if (result.payload.field20 !== 600) errors.push('field20 应该是 600');
  if (result.payload.field218 !== 600) errors.push('field218 应该等于 field20 (600)');
  if (result.payload.field62 !== '正常') errors.push('field62 应该是 \"正常\"');
  if (!result.payload.field8 || !result.payload.field8.id) errors.push('field8 应该有 {id: ...} 结构');
  if (!result.payload.Owner || !result.payload.Owner.id) errors.push('Owner 应该有 {id: ...} 结构');

  if (errors.length > 0) {
    console.error('❌ 验证失败:');
    errors.forEach(e => console.error('  -', e));
    process.exit(1);
  }

  console.log('✅ 所有验证通过！');
}

test().catch(e => {
  console.error('❌ 测试失败:', e.message);
  console.error(e.stack);
  process.exit(1);
});
"

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  本地测试通过！${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${YELLOW}下一步：${NC}"
echo "1. 启动本地服务: cd $SCRIPT_DIR && npm start"
echo "2. 在企微表格测试一条数据"
echo "3. 检查ZOHO沙盒中的字段值"
echo "4. 确认无误后，运行 $SCRIPT_DIR/hotfix-field223.sh 部署到服务器"
echo ""
