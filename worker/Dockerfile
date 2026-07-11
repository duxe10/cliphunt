# ClipHunt worker: Node + yt-dlp + ffmpeg. Deployed to Render as a Docker web service.
FROM node:20-slim

# ffmpeg for trimming/recoding; python3 + curl to fetch a pinned yt-dlp binary.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Pin yt-dlp — YouTube changes break older versions; bump this deliberately.
ARG YTDLP_VERSION=2025.06.30
RUN curl -L "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp" \
    -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
