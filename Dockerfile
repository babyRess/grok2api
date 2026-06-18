FROM oven/bun:1.3.10

WORKDIR /app

ENV NODE_ENV=production \
  GROK_BUILD_API_HOST=0.0.0.0 \
  GROK_BUILD_API_PORT=8990

COPY package.json bun.lock tsconfig.json ./
COPY src ./src

USER bun

EXPOSE 8990

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun --eval "fetch('http://127.0.0.1:' + (process.env.GROK_BUILD_API_PORT || '8990') + '/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "run", "api"]
