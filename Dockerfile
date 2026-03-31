# ── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

# Backend deps + compile TypeScript
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Frontend deps + build (outputs to public/admin)
COPY frontend/package*.json frontend/
RUN npm ci --prefix frontend
COPY frontend ./frontend
RUN npm run frontend:build

# ── Stage 2: production ───────────────────────────────────────────────────────
FROM node:20-alpine AS production
WORKDIR /app

ENV NODE_ENV=production
ENV TZ=Europe/Kyiv

# Only production backend deps
COPY package*.json ./
RUN npm ci --omit=dev

# Compiled app
COPY --from=builder /app/dist ./dist

# Static frontend (built into public/admin)
COPY --from=builder /app/public ./public

# Migration SQL files (runMigrations reads from /app/migrations)
COPY migrations ./migrations

EXPOSE 3000

CMD ["node", "dist/index.js"]
