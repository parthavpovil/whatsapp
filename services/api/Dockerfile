FROM node:20-bookworm-slim AS deps
WORKDIR /app
# Skip Chromium download that puppeteer (a whatsapp-web.js transitive dep) triggers on install.
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json package-lock.json* tsconfig.base.json ./
# Copy ALL workspace package.json files so npm ci can resolve the workspace graph.
COPY packages/shared/package.json ./packages/shared/
COPY services/api/package.json ./services/api/
COPY services/worker/package.json ./services/worker/
COPY services/dispatcher/package.json ./services/dispatcher/
COPY tools/mock-backend/package.json ./tools/mock-backend/
RUN npm ci --workspaces --include-workspace-root

FROM deps AS build
COPY packages/shared ./packages/shared
COPY services/api ./services/api
RUN npm run build --workspace=@wa/shared
RUN npm run build --workspace=@wa/api

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/services/api/dist ./services/api/dist
COPY --from=build /app/services/api/package.json ./services/api/package.json
COPY --from=build /app/package.json ./package.json
EXPOSE 8080
CMD ["node", "services/api/dist/server.js"]
