import { Actor } from "apify";
import { PlaywrightCrawler, Dataset } from "crawlee";

await Actor.init();

const input = await Actor.getInput();
const { urls = [], count = 100000 } = input;

if (!urls.length) throw new Error("No URLs provided in input!");

console.log(
  `Starting LinkedIn scraper for ${urls.length} URL(s), max ${count} jobs each`,
);

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: urls.length,

  // ✅ 6 minute timeout
  requestHandlerTimeoutSecs: 360,

  launchContext: {
    launchOptions: {
      headless: true,
      executablePath: "/usr/bin/google-chrome-stable",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    },
  },

  useSessionPool: true,
  sessionPoolOptions: {
    maxPoolSize: 20,
  },

  maxRequestRetries: 3,

  async requestHandler({ page, request, log }) {
    log.info(`Processing: ${request.url}`);

    await page.waitForLoadState("domcontentloaded");

    await page.waitForSelector(".jobs-search__results-list", {
      timeout: 60000,
    });

    // ✅ AGGRESSIVE SCROLL (loads more jobs)
    let lastCount = 0;

    for (let i = 0; i < 200; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2000);

      const currentCount = await page.$$eval(
        ".jobs-search__results-list li",
        (els) => els.length,
      );

      log.info(`Loaded jobs: ${currentCount}`);

      if (currentCount === lastCount) break;
      lastCount = currentCount;
    }

    // ✅ GET ALL JOB CARDS
    const jobCards = await page.$$(".jobs-search__results-list li");

    const results = [];

    for (let i = 0; i < jobCards.length && results.length < count; i++) {
      try {
        const card = jobCards[i];

        // ✅ CLICK job
        await card.click();
        await page.waitForTimeout(1500);

        // ✅ EXTRACT DATA
        const job = await page.evaluate(() => {
          const getText = (sel) =>
            document.querySelector(sel)?.innerText?.trim() || null;

          return {
            title: getText("h2"),
            company: getText(".topcard__org-name-link, .topcard__flavor"),
            location: getText(".topcard__flavor--bullet"),
            description:
              document.querySelector(".show-more-less-html__markup")
                ?.innerText || null,
            link: window.location.href,
          };
        });

        results.push(job);
      } catch (err) {
        log.warning(`Failed to process job ${i}: ${err.message}`);
      }
    }

    log.info(`Final extracted jobs: ${results.length}`);

    await Dataset.pushData(results);
  },

  failedRequestHandler({ request, error, log }) {
    log.error(`Failed: ${request.url} → ${error.message}`);
  },
});

await crawler.run(urls);

await Actor.exit();
