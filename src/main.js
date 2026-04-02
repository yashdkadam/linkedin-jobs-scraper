import { Actor } from "apify";
import { PlaywrightCrawler } from "crawlee";
import { handleList } from "./list.js";
import { handleDetail } from "./detail.js";

await Actor.init();

const input = await Actor.getInput();

const crawler = new PlaywrightCrawler({
  maxConcurrency: 10, // ⚠️ keep low or LinkedIn blocks
  maxRequestsPerCrawl: input.maxJobs || 10000,

  requestHandler: async (ctx) => {
    const { request } = ctx;

    if (request.label === "DETAIL") {
      await handleDetail(ctx);
    } else {
      await handleList(ctx);
    }
  },

  // 🧠 Anti-blocking config
  useSessionPool: true,
  sessionPoolOptions: {
    maxPoolSize: 50,
  },

  persistCookiesPerSession: true,

  launchContext: {
    launchOptions: {
      headless: true,
    },
  },

  // ⏳ Slow down just enough to avoid 429
  requestHandlerTimeoutSecs: 60,
});

await crawler.run([
  {
    url: input.startUrl,
    label: "LIST",
  },
]);

await Actor.exit();
