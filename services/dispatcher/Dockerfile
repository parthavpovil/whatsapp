FROM node:20-bookworm-slim AS deps
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY services/api/package.json ./services/api/
COPY services/worker/package.json ./services/worker/
COPY services/dispatcher/package.json ./services/dispatcher/
COPY tools/mock-backend/package.json ./tools/mock-backend/
RUN npm ci --workspaces --include-workspace-root

FROM deps AS build
COPY packages/shared ./packages/shared
COPY services/dispatcher ./services/dispatcher
RUN npm run build --workspace=@wa/shared
RUN npm run build --workspace=@wa/dispatcher

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/services/dispatcher/dist ./services/dispatcher/dist
COPY --from=build /app/services/dispatcher/package.json ./services/dispatcher/package.json
COPY --from=build /app/package.json ./package.json
CMD ["node", "services/dispatcher/dist/main.js"]
