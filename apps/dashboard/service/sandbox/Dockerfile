FROM oven/bun:1.3.9 AS build

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY service/sandbox ./service/sandbox

RUN bun build --compile service/sandbox/index.ts --outfile sandbox


FROM oven/bun:1.3.9-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app/sandbox ./sandbox

EXPOSE 8971

CMD ["./sandbox"]
