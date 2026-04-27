# 部署机变更日志 / DEPLOYMENT-LOG

> 记录所有部署相关变更（凭证轮换、域名调整、机器迁移等）。
> **每次重大变更必须在这里加一条**，方便排查问题倒推时间线。

---

## 2026-04-22 — 完成企微回调链路打通 ✅

### 背景
企微智能表格 docid 必须通过事件回调获取（API 不支持直接查询）。需要一个公网HTTPS入口让企微推送事件。

### 决策
- **方案**：Mac mini 内网 + Cloudflare Tunnel 反向隧道
- **域名**：`wecom-cb.cninotary.com`（cninotary.com 已ICP备案，主体匹配公司）
- **不选**：trycloudflare 临时域名（被企微"域名主体校验"拦截）
- **不选**：买云服务器（域名问题不变，且违背"在 Mac mini 上部署"的需求）

### 操作记录
1. 本地装 cloudflared 2026.3.0（从 GitHub releases 下载，因为本地没 brew）
2. `cloudflared tunnel login` 浏览器授权 cninotary.com
3. `cloudflared tunnel create wecom-cb` → 拿到 Tunnel ID
4. `cloudflared tunnel route dns wecom-cb wecom-cb.cninotary.com` → 自动加 CNAME
5. 写 `~/.cloudflared/config.yml` 把流量指向 `localhost:8080`
6. 启动本地回调服务 + 隧道
7. 企微后台填回调URL → URL验证通过 ✅
8. 触发表格变更 → 抓到首个 docid ✅

### 关键产出
- Tunnel ID: `c181072d-0769-4f4a-bbef-71fddba95eb2`
- 首个 docid: `dcIEJwnqOGqzD8e3pNe77th_F2viBzBwf6vQ1P1rtkVucP3qNI-xkQGEO67ORxyM_Uv7XW0yUHCgwpPHupmpOktQ`
- 详细凭证：[DEPLOY-SECRETS.md](../DEPLOY-SECRETS.md)

### 影响范围
- ✅ 不影响 cninotary.com 主站
- ✅ 不影响 inotary.com.hk（独立域名）
- ✅ 不影响 inotary.dpdns.org
- ✅ 不影响公司邮件 / WordPress

### 下次注意
- Cloudflare Free 计划限隧道连接数，单 Tunnel 够用
- cert.pem 是这台机器对 cninotary.com 的"通行证"，**复制到其他机器即可用同一账号建Tunnel**（不用每台都浏览器授权）
- 如果未来要把回调指向新机器，**只需 `cloudflared tunnel run wecom-cb` 在新机器跑起来**，DNS 不用改

---

## 模板（下次复制这一段）

```
## YYYY-MM-DD — 简要标题

### 背景
（为什么要做这次变更）

### 决策
（采取了什么方案，为什么不选其他）

### 操作记录
（具体执行了哪些命令/动作）

### 关键产出
（拿到了什么新的 ID / 文件 / 凭证）

### 影响范围
（哪些服务被改了，哪些没被影响）

### 下次注意
（踩过的坑、未来要小心的地方）
```
