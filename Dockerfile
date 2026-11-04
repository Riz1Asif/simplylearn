# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS dependencies
WORKDIR /app

# Optional trust mounts support managed build proxies without saving session CAs.
RUN --mount=type=secret,id=system_ca \
    if [ -s /run/secrets/system_ca ]; then \
      export APT_CONFIG=/tmp/simplylearn-apt.conf; \
      echo 'Acquire::https::CaInfo "/run/secrets/system_ca";' > "$APT_CONFIG"; \
    fi; \
    apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-impress poppler-utils util-linux tini \
      fonts-liberation fonts-crosextra-carlito fonts-crosextra-caladea fonts-noto-core \
    && rm -rf /var/lib/apt/lists/* /tmp/simplylearn-apt.conf

COPY package.json package-lock.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -s /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --omit=dev --no-fund --no-audit

FROM dependencies AS runtime
ENV NODE_ENV=production DATA_DIR=/app/data
COPY . .
COPY docker-entrypoint.sh /usr/local/bin/simplylearn-entrypoint
RUN chmod -R a+rX /app && chmod 755 /usr/local/bin/simplylearn-entrypoint
EXPOSE 1690
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/simplylearn-entrypoint"]
CMD ["node", "index.js"]
