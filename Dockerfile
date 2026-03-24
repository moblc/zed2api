FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY index.js ./
COPY src/ ./src/
COPY webui/dist/index.html ./webui/dist/index.html
COPY accounts.example.json ./accounts.example.json

EXPOSE 3000
VOLUME ["/app/data"]

ENV PORT=3000

CMD ["/bin/sh", "-c", "cp -n /app/accounts.example.json /app/data/accounts.json 2>/dev/null || true; cd /app/data && node /app/index.js serve ${PORT}"]
