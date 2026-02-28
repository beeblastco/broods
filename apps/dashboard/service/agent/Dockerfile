FROM oven/bun:1.3.9 AS build

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY service ./service
COPY convex/_generated ./convex/_generated

RUN bun build --compile service/agent/index.ts --outfile agent

FROM gcr.io/distroless/cc-debian12 AS runtime

WORKDIR /app

COPY --from=build /app/agent ./agent

EXPOSE 8080

CMD ["./agent"]
