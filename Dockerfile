FROM apify/actor-node-playwright-chrome:18

COPY package*.json ./

RUN npm install --include=dev

# ✅ This line was missing — downloads Chromium into the container
RUN npx playwright install chromium --with-deps

COPY . ./

CMD ["node", "src/main.js"]