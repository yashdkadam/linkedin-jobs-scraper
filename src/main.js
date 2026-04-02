import { Actor } from "apify";
import { PlaywrightCrawler, RequestQueue } from "crawlee";
import { handleList } from "./list.js";
import { handleDetail } from "./detail.js";

await Actor.init();

const input = await Actor.getInput();

const requestQueue = await RequestQueue.open();

// Start with LIST page
await requestQueue.addRequest({
  url: input.url,
  label: "LIST",
});

const crawler = new PlaywrightCrawler({
  requestQueue,

  maxConcurrency: 30, // controlled
  minConcurrency: 10,

  useSessionPool: true,
  persistCookiesPerSession: true,

  sessionPoolOptions: {
    maxPoolSize: 100,
    sessionOptions: {
      maxUsageCount: 20,
    },
  },

  launchContext: {
    launchOptions: {
      headless: true,
    },
  },

  preNavigationHooks: [
    async ({ page }) => {
      await page.route("**/*", (route) => {
        const type = route.request().resourceType();
        if (["image", "stylesheet", "font"].includes(type)) {
          return route.abort();
        }
        route.continue();
      });

      await page.setExtraHTTPHeaders({
        "accept-language": "en-US,en;q=0.9",
      });
    },
  ],

  async requestHandler(ctx) {
    const { request } = ctx;

    if (request.label === "LIST") {
      return handleList(ctx);
    }

    if (request.label === "DETAIL") {
      return handleDetail(ctx);
    }
  },

  failedRequestHandler({ request }) {
    console.log(`❌ Failed: ${request.url}`);
  },
});

await crawler.run();

await Actor.exit();
