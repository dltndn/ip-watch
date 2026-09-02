# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build-dependencies
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
RUN npm run typecheck && npm test

FROM node:24-bookworm-slim AS production-dependencies
WORKDIR /app
RUN apt-get update \
    && apt-get install --yes --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
    && apt-get install --yes --no-install-recommends arp-scan iputils-ping libcap2-bin \
    && rm -rf /var/lib/apt/lists/* \
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
