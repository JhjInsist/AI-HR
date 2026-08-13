FROM node:20-slim
RUN apt-get update && apt-get install -y poppler-utils tesseract-ocr tesseract-ocr-chi-sim && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ARG APP_VERSION=0.1.0
ARG GIT_COMMIT=unknown
ARG BUILD_TIME=unknown
ENV APP_VERSION=${APP_VERSION} \
    GIT_COMMIT=${GIT_COMMIT} \
    BUILD_TIME=${BUILD_TIME}
COPY package*.json ./
RUN npm install --omit=dev
COPY dist ./dist
CMD ["node", "dist/main.js"]
