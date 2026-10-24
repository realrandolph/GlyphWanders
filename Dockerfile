FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-fund
COPY src/adapter ./src/adapter
COPY src/shared ./src/shared
RUN npm run build:bridge

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund
COPY --from=build /app/dist/adapter ./dist/adapter
USER node
EXPOSE 3000
CMD ["node", "dist/adapter/index.js"]
