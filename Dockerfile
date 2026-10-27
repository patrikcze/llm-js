# syntax=docker/dockerfile:1
# llm-agent web UI. Node runs the TypeScript sources directly (type stripping), so there is no build step.
#
# Base image pinned to a patched Node.js release (24.22.1 fixes CVE-2026-111497, the Brotli decoder
# RCE, among others) and to its digest, so a rebuild cannot silently pick up a different image.
# Dependabot proposes updates (.github/dependabot.yml). Check what's inside: make docker-scan.
FROM docker.io/library/node:26.12.1-alpine3.24@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797

ENV NODE_ENV=production
WORKDIR /app

# Alpine security updates first, then the tools for the agent's run_command (it executes inside this
# container) and for grep (ripgrep). The npm bundled with Node lags behind on its own dependencies,
# so it is updated; yarn 1 and corepack are unmaintained or unused here and are removed.
ARG NPM_VERSION=12.2.1
RUN apk upgrade --no-cache \
 && apk add --no-cache bash git curl jq python3 ripgrep make tzdata \
 && npm install -g --ignore-scripts npm@${NPM_VERSION} \
 && rm -rf /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
           /usr/local/lib/node_modules/corepack /usr/local/bin/corepack \
 && npm cache clean --force

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# The agent itself never runs npm, and even the latest npm bundles dependencies with open advisories
# (its own copy of undici and ip-address). So npm is removed unless you ask for it, e.g. for an
# agent that should install packages: make docker-build WITH_NPM=true
ARG WITH_NPM=false
RUN if [ "$WITH_NPM" != "true" ]; then \
      rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /root/.npm; fi

COPY src ./src
COPY web ./web

# Inside the container the server listens on all interfaces; compose publishes it on the
# host's 127.0.0.1 only. Settings (provider, model, API keys) live in the /config volume.
ENV HOST=0.0.0.0 \
    PORT=8787 \
    AGENT_CONFIG_DIR=/config
RUN mkdir -p /workspace /config && chown node:node /workspace /config
USER node

VOLUME ["/workspace", "/config"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.ts", "-w", "/workspace"]
