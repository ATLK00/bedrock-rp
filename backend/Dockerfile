# Build stage: full deps + tsc.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage: production-only deps, compiled dist, migrations, non-root.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# migrate.ts resolves migrations as ../../migrations relative to dist/db.
COPY migrations ./migrations
RUN addgroup -S app && adduser -S app -G app
USER app
EXPOSE 8080
CMD ["node", "dist/index.js"]