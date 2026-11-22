FROM golang:1.26-bookworm AS vpn
RUN CGO_ENABLED=0 go install github.com/windtf/wireproxy/cmd/wireproxy@v1.1.3
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates proxychains4 && rm -rf /var/lib/apt/lists/*
COPY --from=vpn /go/bin/wireproxy /usr/local/bin/wireproxy
WORKDIR /app
COPY . .
RUN mkdir -p perfil-web && chown node:node perfil-web
USER node
RUN --network=none node test/egress.cjs
CMD ["node", "server.cjs"]
