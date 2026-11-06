# Container image for hosting the hub. Most hosting services can run this.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY config ./config
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    COOKIE_SECURE=true
# /data holds classes, pupils and paired tablets. Mount persistent storage here.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "src/server.js"]
