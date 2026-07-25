FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY bridge.mjs ./
USER node
CMD ["node", "bridge.mjs"]
