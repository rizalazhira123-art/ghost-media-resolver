FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ca-certificates \
 && python3 -m pip install --break-system-packages --no-cache-dir -U yt-dlp \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json server.mjs ./
ENV PORT=8788 MAX_CONCURRENT=2 MAX_IMPORT_MB=50 MAX_DURATION_SECONDS=600
EXPOSE 8788
CMD ["node","server.mjs"]
