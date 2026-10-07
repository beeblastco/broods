# The image every cloudflare sandbox boots: bash, python3 and node on PATH, like
# every other provider. The Container idles on sleep; commands arrive by exec.
FROM node:24-trixie-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git python3 ripgrep \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /workspace

WORKDIR /workspace
CMD ["sleep", "infinity"]
