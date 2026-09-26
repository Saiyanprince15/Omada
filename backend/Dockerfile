FROM node:22-bookworm-slim AS build
WORKDIR /app

# Prisma 5.x selects its OpenSSL engine at generate time. Install OpenSSL
# before prisma generate so it targets the OpenSSL 3 runtime available on
# Debian Bookworm instead of falling back to the unavailable OpenSSL 1.1 engine.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Prisma's generated query engine requires libssl at runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
EXPOSE 3000
CMD ["node","dist/index.js"]
