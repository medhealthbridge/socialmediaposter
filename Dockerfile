FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
ENV HOST=0.0.0.0 PORT=3000 NODE_NO_WARNINGS=1
VOLUME /app/data
EXPOSE 3000
CMD ["node", "src/server.js"]
