FROM apify/actor-node-playwright-chrome:18

COPY package*.json ./
RUN npm install --include=dev

COPY . ./

CMD ["node", "src/main.js"]
