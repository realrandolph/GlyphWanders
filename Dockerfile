FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-fund
COPY src/bridge ./src/bridge
COPY src/shared ./src/shared
RUN npm run build:bridge

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 SQLITE_PATH=/data/glyphwanders.sqlite
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund && mkdir /data && chown node:node /data
COPY --from=build /app/dist/bridge ./dist/bridge
USER node
VOLUME /data
EXPOSE 3000
CMD ["node", "dist/bridge/index.js"]
