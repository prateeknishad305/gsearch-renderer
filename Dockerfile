FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
    chromium \
    fonts-liberation \
    fonts-noto-core \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libgbm1 \
    libasound2 \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY api ./api
COPY server.js ./
COPY proxies.txt ./

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    CHROMIUM_SOURCE=system \
    CHROMIUM_PATH=/usr/bin/chromium \
    BROWSER_REUSE=1 \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
