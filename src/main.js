import { Actor } from "apify";
import { PlaywrightCrawler, Dataset, RequestQueue } from "crawlee";

await Actor.init();

const input = await Actor.getInput();
const { urls = [], count = 1000 } = input;

if (!urls.length) throw new Error("No URLs provided!");

console.log(`Starting scraper for ${urls.length} URL(s), max ${count}`);

// ✅ Dedup set
const seenJobs = new Set();

// ✅ Request Queue (for pagination + job links)
const requestQueue = await RequestQueue.open();

// Add initial search URLs
for (const url of urls) {
  await requestQueue.addRequest({
    url,
    userData: { label: "LIST" },
  });
}

const crawler = new PlaywrightCrawler({
  requestQueue,

  // ✅ 6 min timeout
  requestHandlerTimeoutSecs: 360,

  // ✅ Parallel scraping
  maxConcurrency: 10,

  launchContext: {
    launchOptions: {
      headless: true,
      executablePath: "/usr/bin/google-chrome-stable",
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    },
  },

  useSessionPool: true,
  maxRequestRetries: 3,

  async requestHandler({ page, request, enqueueLinks, log }) {
    const { label } = request.userData;

    // =========================
    // 📄 LIST PAGE (Search page)
    // =========================
    if (label === "LIST") {
      log.info(`LIST: ${request.url}`);

      await page.waitForLoadState("domcontentloaded");

      await page.waitForSelector(".jobs-search__results-list", {
        timeout: 60000,
      });

      // ✅ Scroll to load jobs
      let prevCount = 0;
      for (let i = 0; i < 20; i++) {
        await page.evaluate(() =>
          window.scrollTo(0, document.body.scrollHeight),
        );
        await page.waitForTimeout(1500);

        const countNow = await page.$$eval(
          ".jobs-search__results-list li",
          (els) => els.length,
        );

        if (countNow === prevCount) break;
        prevCount = countNow;
      }

      // ✅ Extract job links
      const links = await page.$$eval(".jobs-search__results-list li a", (as) =>
        as.map((a) => a.href),
      );

      log.info(`Found ${links.length} job links`);

      // ✅ Enqueue job detail pages (dedup here too)
      for (const link of links) {
        if (!seenJobs.has(link)) {
          seenJobs.add(link);

          await requestQueue.addRequest({
            url: link,
            userData: { label: "DETAIL" },
          });
        }
      }

      // =========================
      // 🔥 PAGINATION
      // =========================
      const nextBtn = await page.$('button[aria-label="Next"]');

      if (nextBtn) {
        const isDisabled = await nextBtn.getAttribute("disabled");

        if (!isDisabled) {
          const nextUrl = await page.evaluate(() => {
            const btn = document.querySelector('button[aria-label="Next"]');
            btn.click();
            return window.location.href;
          });

          log.info(`Enqueue next page`);

          await requestQueue.addRequest({
            url: nextUrl,
            userData: { label: "LIST" },
          });
        }
      }
    }

    // =========================
    // 📄 DETAIL PAGE
    // =========================
    else if (label === "DETAIL") {
      log.info(`DETAIL: ${request.url}`);

      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(1500);

      const job = await page.evaluate(() => {
        const getText = (sel) =>
          document.querySelector(sel)?.innerText?.trim() || null;

        return {
          title: getText("h1"),
          company: getText(".topcard__org-name-link, .topcard__flavor"),
          location: getText(".topcard__flavor--bullet"),
          description:
            document.querySelector(".show-more-less-html__markup")?.innerText ||
            null,
          link: window.location.href,
        };
      });

      await Dataset.pushData(job);
    }
  },

  failedRequestHandler({ request, error, log }) {
    log.error(`Failed: ${request.url} → ${error.message}`);
  },
});

await crawler.run();

await Actor.exit();
