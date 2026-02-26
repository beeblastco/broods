FROM oven/bun:1.3.9

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY service ./service

EXPOSE 8080

CMD ["bun", "service/index.ts"]
