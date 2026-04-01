import { Actor } from "apify";
import { PlaywrightCrawler, Dataset } from "crawlee";

await Actor.init();

const input = await Actor.getInput();
const { urls = [], count = 100 } = input;

if (!urls.length) throw new Error("No URLs provided in input!");

console.log(
  `Starting LinkedIn scraper for ${urls.length} URL(s), max ${count} jobs each`,
);

// ✅ Create crawler
const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: urls.length,

  launchContext: {
    launchOptions: {
      headless: true,
      executablePath: "/usr/bin/google-chrome-stable", // ✅ Apify Chrome
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    },
  },

  // ✅ Anti-blocking
  useSessionPool: true,
  sessionPoolOptions: {
    maxPoolSize: 10,
  },

  // ✅ Retry failed requests
  maxRequestRetries: 3,

  // ✅ Handle each page
  async requestHandler({ page, request, log }) {
    log.info(`Processing: ${request.url}`);

    // ✅ Wait for page load
    await page.waitForLoadState("domcontentloaded");

    // ✅ Wait for job list
    await page.waitForSelector(".jobs-search__results-list", {
      timeout: 30000,
    });

    // ✅ Scroll to load more jobs
    let previousHeight = 0;
    for (let i = 0; i < 10; i++) {
      const currentHeight = await page.evaluate(
        () => document.body.scrollHeight,
      );

      if (currentHeight === previousHeight) break;

      previousHeight = currentHeight;

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2000);
    }

    // ✅ Extract jobs
    const jobs = await page.$$eval(".jobs-search__results-list li", (items) =>
      items.slice(0, 100).map((el) => ({
        title: el.querySelector("h3")?.innerText || null,
        company: el.querySelector("h4")?.innerText || null,
        location:
          el.querySelector(".job-search-card__location")?.innerText || null,
        link: el.querySelector("a")?.href || null,
      })),
    );

    log.info(`Extracted ${jobs.length} jobs`);

    // ✅ Save to dataset
    await Dataset.pushData(jobs.slice(0, count));
  },

  // ❌ Handle failures gracefully
  failedRequestHandler({ request, error, log }) {
    log.error(`Failed: ${request.url} → ${error.message}`);
  },
});

// ✅ Run crawler
await crawler.run(urls);

await Actor.exit();
