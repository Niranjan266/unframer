# Unframer server.
#
# Two stages so the runtime image carries compiled output and production
# dependencies only — not the toolchain, the tests, or Playwright's browsers.
# Browser-based verification is a development and CI concern; the server itself
# never needs Chromium.

FROM node:22-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Exports are written under the system temp directory; give the unprivileged
# user somewhere it can actually write.
RUN mkdir -p /tmp/unframer && chown -R node:node /tmp/unframer
USER node

EXPOSE 3000

# The server binds every interface inside the container; publish it deliberately.
# Read SECURITY.md before exposing this to the internet — it fetches URLs that
# whoever can reach it supplies.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/cli.js", "serve", "--port", "3000"]
