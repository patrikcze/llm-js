# syntax=docker/dockerfile:1
# llm-agent web UI. Node runs the TypeScript sources directly (type stripping), so there is no build step.
ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

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
