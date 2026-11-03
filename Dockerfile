FROM node:24-slim
WORKDIR /app
COPY package.json ./
COPY db.js server.js seed.js ./
COPY public ./public
COPY contracts ./contracts
ENV PORT=8080 PDS_DB=/data/diary.sqlite NODE_ENV=production
EXPOSE 8080
# 빈 DB일 때만 시작 자료를 넣고(seed.js), 서버를 시작한다
CMD ["sh", "-c", "node seed.js && node server.js"]
