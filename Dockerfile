FROM oven/bun:1.3.12-slim AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.12-slim
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/peerflow-browsers
# Chromium prints HTML/CSS directly to vector PDF through the TypeScript worker.
RUN bunx playwright install --with-deps chromium
COPY src ./src
COPY scripts ./scripts
COPY core/templates ./core/templates
COPY core/static ./core/static
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8000
RUN mkdir -p /app/data /app/media
EXPOSE 8000
CMD ["bun", "run", "src/index.ts"]
