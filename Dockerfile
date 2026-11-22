FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN mkdir -p perfil-web && chown node:node perfil-web
USER node
CMD ["node", "server.cjs"]
