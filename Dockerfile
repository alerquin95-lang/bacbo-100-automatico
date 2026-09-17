
FROM node:18-slim

# Instala deps do Chromium para Puppeteer
RUN apt-get update && apt-get install -y     chromium     ca-certificates     fonts-liberation     libasound2     libatk-bridge2.0-0     libatk1.0-0     libatspi2.0-0     libcups2     libdbus-1-3     libdrm2     libgbm1     libgtk-3-0     libnspr4     libnss3     libxcomposite1     libxdamage1     libxfixes3     libxrandr2     libxshaped     libxss1     libxtst6     xdg-utils     python3     make     g++     && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app
COPY package-final.json ./package.json
RUN npm install

COPY server-final-24h-BACBO.js ./

EXPOSE 3000
CMD ["npm", "start"]
