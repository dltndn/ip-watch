# syntax=docker/dockerfile:1

# Node.js 24 security patch (CVE-2026-111497) 이상으로 고정
ARG NODE_IMAGE=node:24.22.1-bookworm-slim

FROM ${NODE_IMAGE} AS build-dependencies
WORKDIR /app
RUN apt-get update \
    && apt-get install --yes --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM build-dependencies AS build
COPY tsconfig.json tsconfig.test.json ./
COPY src ./src
RUN npm run build

FROM build AS development
ENV NODE_ENV=development
COPY tests ./tests
COPY views ./views
COPY public ./public
CMD ["npm", "run", "dev"]

FROM build AS test
COPY tests ./tests
COPY views ./views
COPY public ./public
RUN npm run typecheck && npm test

FROM ${NODE_IMAGE} AS production-dependencies
WORKDIR /app
RUN apt-get update \
    && apt-get install --yes --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
    && apt-get install --yes --no-install-recommends arp-scan iputils-ping libcap2-bin \
    && rm -rf /var/lib/apt/lists/* \
    && setcap cap_net_raw+p /usr/sbin/arp-scan \
    && getcap /usr/sbin/arp-scan \
    && mkdir -p /app/data \
    && chown node:node /app/data
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./package.json
COPY views ./views
COPY public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 3000}/health`).then((response) => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"]
CMD ["node", "dist/main.js"]
