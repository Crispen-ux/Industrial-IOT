FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
COPY backend/package.json backend/package-lock.json* ./backend/
COPY gateway/package.json gateway/package-lock.json* ./gateway/

RUN cd backend && npm ci --omit=dev
RUN cd gateway && npm ci --omit=dev

COPY backend/ ./backend/
COPY gateway/ ./gateway/
COPY frontend/ ./frontend/

EXPOSE 4000 9090

USER node

CMD ["node", "backend/server.js"]
