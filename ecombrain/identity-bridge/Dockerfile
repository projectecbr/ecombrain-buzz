FROM node:24-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY bridge.mjs provisioning.mjs ./

USER node
EXPOSE 3000
CMD ["node", "bridge.mjs"]
