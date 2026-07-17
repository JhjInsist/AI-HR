FROM node:20-slim
RUN apt-get update && apt-get install -y poppler-utils tesseract-ocr tesseract-ocr-chi-sim && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY dist ./dist
CMD ["node", "dist/main.js"]
