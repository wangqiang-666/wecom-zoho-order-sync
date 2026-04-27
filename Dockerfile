# syntax=docker/dockerfile:1.6
# ============================================================
# wecom-zoho-order-sync 生产镜像
# - Node 20 LTS (alpine)
# - better-sqlite3 需要 python3 + make + g++ 编译原生模块
# ============================================================

FROM node:20-alpine

# 设置时区（与 .env 中 TZ=Asia/Shanghai 保持一致）
ENV TZ=Asia/Shanghai
RUN apk add --no-cache tzdata python3 make g++ \
    && cp /usr/share/zoneinfo/$TZ /etc/localtime \
    && echo $TZ > /etc/timezone

WORKDIR /app

# 先拷 package.json，充分利用 Docker 层缓存
COPY package.json package-lock.json ./

# 只装生产依赖；强制重新编译 better-sqlite3 以匹配容器架构（arm64 musl）
RUN npm ci --omit=dev \
    && npm rebuild better-sqlite3

# 拷业务代码与配置
COPY src ./src
COPY scripts ./scripts
COPY config ./config

# 数据和日志目录（会被 volume 覆盖，但保证镜像层存在）
RUN mkdir -p /app/data /app/logs

# 非 root 用户运行
RUN chown -R node:node /app
USER node

# 暴露端口（admin UI + 企微回调）
EXPOSE 3300 8080

# 启动命令
CMD ["node", "src/index.js"]
