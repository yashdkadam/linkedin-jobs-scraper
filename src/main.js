import { Actor } from "apify";
import { PlaywrightCrawler, Dataset, RequestQueue } from "crawlee";

await Actor.init();

const input = await Actor.getInput();

const {
  url, // 🔥 single URL input
  maxJobs = 100, // limit
} = input;

if (!url) throw new Error("Please provide 'url'");

const requestQueue = await RequestQueue.open();
const seen = new Set();

// Seed only ONE URL
await requestQueue.addRequest({
  url,
  userData: { label: "LIST", page: 0 },
});

const crawler = new PlaywrightCrawler({
  requestQueue,

  // ✅ Safe config (avoid 429)
  minConcurrency: 3,
  maxConcurrency: 8,

  requestHandlerTimeoutSecs: 90,
  maxRequestRetries: 3,

  useSessionPool: true,
  persistCookiesPerSession: true,

  sessionPoolOptions: {
    maxPoolSize: 50,
    sessionOptions: {
      maxUsageCount: 20,
    },
  },

  async requestHandler({ page, request, log }) {
    const { label, page: pageNum = 0 } = request.userData;

    // =========================
    // 📄 LIST PAGE
    // =========================
    if (label === "LIST") {
      log.info(`Scraping LIST page ${pageNum + 1}`);

      await page.waitForSelector(".jobs-search__results-list", {
        timeout: 15000,
      });

      // 🔽 Scroll to load all jobs
      let prev = 0;
      for (let i = 0; i < 10; i++) {
        await page.evaluate(() =>
          window.scrollTo(0, document.body.scrollHeight),
        );
        await page.waitForTimeout(300);

        const count = await page.$$eval(
          ".jobs-search__results-list li",
          (els) => els.length,
        );

        if (count === prev) break;
        prev = count;
      }

      // 🔗 Extract links
      let links = await page.$$eval(".jobs-search__results-list li a", (as) =>
        as.map((a) => a.href),
      );

      links = links.filter(
        (l) => l && l.includes("/jobs/view/") && !l.includes("authwall"),
      );

      log.info(`Found ${links.length} jobs`);

      for (const link of links) {
        if (seen.size >= maxJobs) break;

        if (!seen.has(link)) {
          seen.add(link);

          await requestQueue.addRequest({
            url: link,
            userData: { label: "DETAIL" },
          });
        }
      }

      // Pagination (same query only)
      if (seen.size < maxJobs) {
        const nextStart = (pageNum + 1) * 25;

        const nextUrl = new URL(request.url);
        nextUrl.searchParams.set("start", nextStart);

        await requestQueue.addRequest({
          url: nextUrl.toString(),
          userData: { label: "LIST", page: pageNum + 1 },
        });

        log.info(`Queued page ${pageNum + 2}`);
      }
    }

    // =========================
    // 📄 DETAIL PAGE
    // =========================
    else {
      if (request.url.includes("authwall")) return;

      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(300);

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

      if (!job?.title) return;

      await Dataset.pushData(job);

      log.info(`✓ ${job.title}`);
    }
  },
});

await crawler.run();

await Actor.exit();
