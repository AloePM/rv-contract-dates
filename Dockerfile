FROM node:18-slim
WORKDIR /app
COPY package.json ./
COPY index.js ./
COPY csv-data.js ./
CMD ["node", "index.js"]
