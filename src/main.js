import { Actor } from "apify";
import {
  PlaywrightCrawler,
  HttpCrawler,
  ProxyConfiguration,
  Dataset,
} from "crawlee";

await Actor.init();

// 🔥 PROXY CONFIG (ROTATION)
const proxyConfiguration = await Actor.createProxyConfiguration({
  useApifyProxy: true,
  groups: ["RESIDENTIAL"], // BEST for LinkedIn
});

// 🔥 DEDUP SET
const seen = new Set();

// ========================================
// ⚡ FAST LIST SCRAPER (HTTP BASED)
// ========================================
const listCrawler = new HttpCrawler({
  proxyConfiguration,
  maxConcurrency: 50, // 🔥 HIGH
  requestHandler: async ({ request, body, enqueueLinks, log }) => {
    const html = body.toString();

    const links = [
      ...html.matchAll(
        /href="(https:\/\/www\.linkedin\.com\/jobs\/view\/[^"]+)"/g,
      ),
    ].map((m) => m[1]);

    log.info(`Found ${links.length} jobs`);

    const uniqueLinks = links.filter((l) => {
      if (seen.has(l)) return false;
      seen.add(l);
      return true;
    });

    await enqueueLinks({
      urls: uniqueLinks,
      label: "DETAIL",
    });
  },
});

// ========================================
// 🧠 DETAIL SCRAPER (LIMITED PLAYWRIGHT)
// ========================================
const detailCrawler = new PlaywrightCrawler({
  proxyConfiguration,
  maxConcurrency: 20, // 🔥 balance speed + avoid block

  launchContext: {
    launchOptions: {
      headless: true,
    },
  },

  requestHandler: async ({ page, request, log }) => {
    try {
      await page.goto(request.url, { timeout: 15000 });

      // ❌ skip authwall
      if (page.url().includes("authwall")) {
        log.warning(`Blocked: ${request.url}`);
        return;
      }

      const data = await page.evaluate(() => ({
        title: document.querySelector("h1")?.innerText || null,
        company:
          document.querySelector(".topcard__org-name-link")?.innerText || null,
        location:
          document.querySelector(".topcard__flavor--bullet")?.innerText || null,
        description:
          document.querySelector(".show-more-less-html__markup")?.innerText ||
          null,
        link: window.location.href,
      }));

      await Dataset.pushData(data);
    } catch (err) {
      log.error(`Failed: ${request.url}`);
    }
  },
});

// ========================================
// 🚀 START FLOW
// ========================================

// 🔥 PAGINATION (1000+ jobs)
const startUrls = [];

for (let i = 0; i < 1000; i += 25) {
  startUrls.push(
    `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?start=${i}`,
  );
}

await listCrawler.run(startUrls);

// 🔥 Process detail pages in parallel
await detailCrawler.run();

await Actor.exit();
