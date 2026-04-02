import { Actor } from "apify";
import { PlaywrightCrawler, Dataset, RequestQueue } from "crawlee";

await Actor.init();

const input = await Actor.getInput();

const {
  startUrls = [
    "https://www.linkedin.com/jobs/search/?keywords=software&location=India",
  ],
  maxJobs = 8000,
} = input;

// 🔐 Proxy (MANDATORY for LinkedIn at scale)
const proxyConfiguration = await Actor.createProxyConfiguration({
  useApifyProxy: true,
  groups: ["RESIDENTIAL"],
});

// 📦 Queue + dedup
const requestQueue = await RequestQueue.open();
const seen = new Set();

// 🌱 Seed LIST pages
for (const url of startUrls) {
  await requestQueue.addRequest({
    url,
    userData: { label: "LIST", page: 0 },
  });
}

const crawler = new PlaywrightCrawler({
  requestQueue,
  proxyConfiguration,

  // ⚡ HIGH PARALLELISM
  minConcurrency: 10,
  maxConcurrency: 40,

  // ⏱ Timeouts
  requestHandlerTimeoutSecs: 90,
  maxRequestRetries: 3,

  // 🔄 Session rotation
  useSessionPool: true,
  sessionPoolOptions: {
    maxPoolSize: 100,
  },

  launchContext: {
    launchOptions: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
      ],
    },
  },

  async requestHandler({ page, request, log }) {
    const { label, page: pageNum = 0 } = request.userData;

    // =========================
    // 📄 LIST PAGE (FAST)
    // =========================
    if (label === "LIST") {
      log.info(`LIST page ${pageNum}: ${request.url}`);

      await page.waitForSelector(".jobs-search__results-list", {
        timeout: 15000,
      });

      // 🔽 Minimal scroll (LinkedIn loads quickly)
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(500);

      // 🔗 Extract links
      let links = await page.$$eval(".jobs-search__results-list li a", (as) =>
        as.map((a) => a.href),
      );

      // ✅ Clean links
      links = links.filter(
        (l) => l && l.includes("/jobs/view/") && !l.includes("authwall"),
      );

      log.info(`Found ${links.length} links`);

      // 🚀 Enqueue DETAIL pages (parallel engine)
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

      // 🔁 Pagination (SUPER FAST)
      if (seen.size < maxJobs) {
        const nextStart = (pageNum + 1) * 25;

        const nextUrl = new URL(request.url);
        nextUrl.searchParams.set("start", nextStart);

        await requestQueue.addRequest({
          url: nextUrl.toString(),
          userData: { label: "LIST", page: pageNum + 1 },
        });

        log.info(`Queued next page: ${nextStart}`);
      }
    }

    // =========================
    // 📄 DETAIL PAGE (PARALLEL)
    // =========================
    else if (label === "DETAIL") {
      // ❌ Skip blocked
      if (request.url.includes("authwall")) return;

      await page.waitForLoadState("domcontentloaded");

      // Small delay to stabilize DOM
      await page.waitForTimeout(200);

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

      if (!job.title) return;

      await Dataset.pushData(job);

      log.info(`✓ ${job.title}`);
    }
  },

  failedRequestHandler({ request, log }) {
    log.error(`Failed: ${request.url}`);
  },
});

await crawler.run();

await Actor.exit();
