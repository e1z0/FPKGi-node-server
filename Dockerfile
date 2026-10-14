FROM node:22-alpine

WORKDIR /app

COPY --chown=node:node linux/ ./

RUN apk add --no-cache shadow su-exec \
    && chmod +x /app/docker-entrypoint.sh \
    && mkdir -p /data/pkgs /data/covers /data/json \
    && chown -R node:node /data

ENV PUID=1000 \
    PGID=1000 \
    FPKGI_HTTP_PORT=8080 \
    FPKGI_JSON_PORT=3000 \
    FPKGI_PKG_PATH=/data/pkgs \
    FPKGI_COVERS_PATH=/data/covers \
    FPKGI_JSON_PATH=/data/json \
    FPKGI_SCAN_INTERVAL_SECONDS=0

EXPOSE 8080 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e 'require("http").get(`http://127.0.0.1:${process.env.FPKGI_JSON_PORT}/`,r=>process.exit(r.statusCode===200?0:1)).on("error",()=>process.exit(1))'

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "docker-entrypoint.js"]
