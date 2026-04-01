import { Actor } from "apify";
import { PlaywrightCrawler, Dataset, RequestQueue } from "crawlee";

await Actor.init();

const input = await Actor.getInput();
const { urls = [], count = 1000 } = input;

if (!urls.length) throw new Error("No URLs provided!");

const seen = new Set();
const requestQueue = await RequestQueue.open();

// ✅ Seed URLs
for (const url of urls) {
  await requestQueue.addRequest({
    url,
    userData: { label: "LIST" },
  });
}

const crawler = new PlaywrightCrawler({
  requestQueue,

  // 🔥 PROXY (CRITICAL for LinkedIn)
  proxyConfiguration: await Actor.createProxyConfiguration({
    useApifyProxy: true,
    groups: ["RESIDENTIAL"],
  }),

  // 🔥 SAFE PARALLELISM
  minConcurrency: 5,
  maxConcurrency: 15,

  // ⏱ Timeouts
  requestHandlerTimeoutSecs: 120,
  maxRequestRetries: 5,

  // 🔄 Session rotation
  useSessionPool: true,
  sessionPoolOptions: {
    maxPoolSize: 50,
  },

  launchContext: {
    launchOptions: {
      headless: true,
      executablePath: "/usr/bin/google-chrome-stable",
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    },
  },

  async requestHandler({ page, request, log }) {
    const { label } = request.userData;

    // 🔥 HUMAN-LIKE DELAY
    await page.waitForTimeout(2000 + Math.random() * 2000);

    // =========================
    // 📄 LIST PAGE
    // =========================
    if (label === "LIST") {
      log.info(`LIST: ${request.url}`);

      await page.waitForLoadState("domcontentloaded");

      await page.waitForSelector(".jobs-search__results-list", {
        timeout: 30000,
      });

      // 🔽 Scroll to load jobs
      let prevCount = 0;

      for (let i = 0; i < 10; i++) {
        await page.evaluate(() =>
          window.scrollTo(0, document.body.scrollHeight),
        );
        await page.waitForTimeout(1200);

        const currentCount = await page.$$eval(
          ".jobs-search__results-list li",
          (els) => els.length,
        );

        if (currentCount === prevCount) break;
        prevCount = currentCount;
      }

      // 🔗 Extract job links
      let links = await page.$$eval(".jobs-search__results-list li a", (as) =>
        as.map((a) => a.href),
      );

      // ❌ Remove authwall + invalid links
      links = links.filter(
        (l) => l && !l.includes("authwall") && l.includes("/jobs/view/"),
      );

      log.info(`Valid links: ${links.length}`);

      // ✅ Enqueue detail pages (dedup)
      for (const link of links) {
        if (!seen.has(link) && seen.size < count) {
          seen.add(link);

          await requestQueue.addRequest({
            url: link,
            userData: { label: "DETAIL" },
          });
        }
      }

      // 🔥 PAGINATION
      const nextBtn = await page.$('button[aria-label="Next"]');

      if (nextBtn) {
        const disabled = await nextBtn.isDisabled();

        if (!disabled) {
          log.info("Moving to next page...");

          await nextBtn.click();
          await page.waitForTimeout(2500);

          await requestQueue.addRequest({
            url: page.url(),
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

      // ❌ Skip blocked pages
      if (page.url().includes("authwall")) {
        log.warning("Blocked (authwall) → skipping");
        return;
      }

      await page.waitForTimeout(1000);

      const job = await page.evaluate(() => {
        const get = (sel) =>
          document.querySelector(sel)?.innerText?.trim() || null;

        return {
          title: get("h1"),
          company: get(".topcard__org-name-link, .topcard__flavor"),
          location: get(".topcard__flavor--bullet"),
          description:
            document.querySelector(".show-more-less-html__markup")?.innerText ||
            null,
          link: window.location.href,
        };
      });

      // ❌ Skip empty results
      if (!job.title) return;

      await Dataset.pushData(job);
    }
  },

  failedRequestHandler({ request, error, log }) {
    log.error(`Failed: ${request.url} → ${error.message}`);
  },
});

await crawler.run();

await Actor.exit();
