FROM node:22-bookworm-slim

ARG CODEX_NPM_PACKAGE=@openai/codex
ARG CODEX_NPM_VERSION=latest

ENV NODE_ENV=production \
    CODEX_HOME=/var/lib/codex \
    OCTOP_STATE_HOME=/var/lib/octop \
    OCTOP_WORKSPACE_ROOTS=/workspace \
    OCTOP_BRIDGE_HOST=0.0.0.0 \
    OCTOP_BRIDGE_PORT=4100 \
    OCTOP_APP_SERVER_WS_URL=ws://127.0.0.1:4600 \
    OCTOP_APP_SERVER_AUTOSTART=true

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git openssh-client tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/octop

COPY package.json package-lock.json ./
COPY services/codex-adapter/package.json ./services/codex-adapter/package.json
RUN npm ci --omit=dev --workspace @octop/codex-adapter

RUN npm install -g "${CODEX_NPM_PACKAGE}@${CODEX_NPM_VERSION}" \
    && codex --version

COPY scripts ./scripts
COPY services/codex-adapter ./services/codex-adapter
COPY docker/bridge/entrypoint.sh ./docker/bridge/entrypoint.sh

RUN mkdir -p /workspace "$CODEX_HOME" "$OCTOP_STATE_HOME" \
    && chmod +x ./docker/bridge/entrypoint.sh

EXPOSE 4100

ENTRYPOINT ["/usr/bin/tini", "--", "/opt/octop/docker/bridge/entrypoint.sh"]
CMD []
