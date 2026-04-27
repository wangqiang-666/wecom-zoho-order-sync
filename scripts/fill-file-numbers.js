#!/usr/bin/env node
/**
 * 从ZOHO API获取文件编号并填入Excel表格
 */

const xlsx = require('node-xlsx');
const fs = require('fs');
const https = require('https');
require('dotenv').config();

// ZOHO配置
const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const ZOHO_MODULE = process.env.ZOHO_MODULE_API_NAME || 'CustomModule18';
const ZOHO_API_BASE = process.env.ZOHO_ENV === 'sandbox'
  ? 'https://sandbox.zohoapis.com.cn/crm/v2'
  : 'https://www.zohoapis.com.cn/crm/v2';

let accessToken = null;

// 获取access token
async function getAccessToken() {
  if (accessToken) return accessToken;

  const url = `https://accounts.zoho.com.cn/oauth/v2/token?refresh_token=${ZOHO_REFRESH_TOKEN}&client_id=${ZOHO_CLIENT_ID}&client_secret=${ZOHO_CLIENT_SECRET}&grant_type=refresh_token`;

  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const json = JSON.parse(data);
        if (json.access_token) {
          accessToken = json.access_token;
          console.log('✓ ZOHO access_token 已获取');
          resolve(accessToken);
        } else {
          reject(new Error('获取access_token失败: ' + data));
        }
      });
    }).on('error', reject);
  });
}

// 从ZOHO搜索记录
async function searchZohoBySubject(subject) {
  const token = await getAccessToken();
  const searchUrl = `${ZOHO_API_BASE}/${ZOHO_MODULE}/search?criteria=(Name:equals:${encodeURIComponent(subject)})`;

  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'Authorization': `Zoho-oauthtoken ${token}`
      }
    };

    https.get(searchUrl, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.data && json.data.length > 0) {
            const record = json.data[0];
            const fileNo = record.field73 || record.Name1 || null;
            resolve({ subject, fileNo, zohoId: record.id });
          } else {
            resolve({ subject, fileNo: null, zohoId: null });
          }
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  // 读取Excel文件
  const excelPath = '/Users/yyzinotary/Desktop/17份-20260424.xlsx';
  const sheets = xlsx.parse(excelPath);
  const data = sheets[0].data;

  console.log('读取Excel文件:', excelPath);
  console.log('总行数:', data.length);

  // 提取主题列表（跳过表头）
  const subjects = [];
  for (let i = 1; i < data.length; i++) {
    const subject = data[i][0];
    if (subject) {
      subjects.push({ index: i, subject });
    }
  }

  console.log('\n需要查询的主题数量:', subjects.length);
  console.log('\n正在从ZOHO查询文件编号...\n');

  // 逐个查询ZOHO
  for (const item of subjects) {
    try {
      const result = await searchZohoBySubject(item.subject);
      if (result.fileNo) {
        data[item.index][1] = result.fileNo;
        console.log(`✓ ${item.subject} → ${result.fileNo}`);
      } else {
        console.log(`✗ ${item.subject} → 未找到`);
      }
      // 避免API限流
      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (e) {
      console.error(`✗ ${item.subject} → 查询失败:`, e.message);
    }
  }

  // 保存更新后的Excel
  const buffer = xlsx.build([{ name: sheets[0].name, data }]);
  fs.writeFileSync(excelPath, buffer);

  console.log('\n✓ Excel文件已更新:', excelPath);
  console.log('\n更新结果:');
  for (let i = 1; i < data.length; i++) {
    console.log(`  ${data[i][0]} → ${data[i][1] || '(未找到)'}`);
  }
}

main().catch(console.error);
