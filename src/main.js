import { Actor } from "apify";
import { PlaywrightCrawler, Dataset, sleep } from "crawlee";
import { chromium } from "playwright";
import { extractJobDetails, buildPaginatedUrls } from "./utils.js";

await Actor.init();

const input = (await Actor.getInput()) ?? {};

const {
  startUrl = "https://www.linkedin.com/jobs/search/?currentJobId=4331964856&f_E=1%2C2%2C3&f_F=it%2Ceng&f_TPR=r86400&geoId=102713980&keywords=&location=India&origin=JOB_SEARCH_PAGE_JOB_FILTER&sortBy=R&trk=public_jobs_jobs-search-bar_search-submit",
  maxJobs = 100,
  maxPagesPerQuery = 5,
  delayBetweenJobsMs = 1500,
  proxyConfiguration: proxyConfig,
} = input;

const proxyConfiguration = proxyConfig
  ? await Actor.createProxyConfiguration(proxyConfig)
  : undefined;

let jobsScraped = 0;

const crawler = new PlaywrightCrawler({
  proxyConfiguration,
  launchContext: {
    launcher: chromium,
    launchOptions: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
      ],
    },
  },
  browserPoolOptions: {
    useFingerprints: true,
  },
  maxRequestsPerCrawl: maxPagesPerQuery * 25 + 10,
  requestHandlerTimeoutSecs: 120,

  async requestHandler({ page, request, log }) {
    log.info(`Processing: ${request.url}`);

    // ── Anti-detection: mask navigator.webdriver ──
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    // ── Navigate and wait for job list ──
    await page.waitForSelector("ul.jobs-search__results-list", {
      timeout: 30_000,
    });
    await sleep(1500);

    const pageNum = request.userData?.pageNum ?? 0;
    log.info(`Scraping page ${pageNum + 1}...`);

    // ── Collect all job cards on this page ──
    const jobCards = await page.$$("ul.jobs-search__results-list > li");
    log.info(`Found ${jobCards.length} job cards`);

    for (let i = 0; i < jobCards.length; i++) {
      if (jobsScraped >= maxJobs) {
        log.info(`Reached maxJobs limit (${maxJobs}). Stopping.`);
        return;
      }

      const card = jobCards[i];

      // ── Extract link + basic card data before clicking ──
      const cardLink = await card
        .$eval("a.base-card__full-link", (el) => el.href)
        .catch(() => null);

      // ── Click the card to load details in the right panel ──
      try {
        await card.scrollIntoViewIfNeeded();
        await card.click();
      } catch {
        log.warning(`Could not click card ${i + 1}, skipping.`);
        continue;
      }

      // ── Wait for right panel to update ──
      try {
        await page.waitForSelector(
          ".job-view-layout, .details-pane__content, .show-more-less-html",
          { timeout: 15_000 },
        );
      } catch {
        log.warning(`Detail panel did not load for card ${i + 1}, skipping.`);
        continue;
      }

      await sleep(delayBetweenJobsMs);

      // ── Extract structured data from the right panel ──
      const job = await page.evaluate(extractJobDetails).catch((err) => {
        log.warning(`Extraction failed for card ${i + 1}: ${err.message}`);
        return null;
      });

      if (!job) continue;

      // Prefer the direct card link if panel link is missing
      if (!job.link && cardLink) job.link = cardLink;

      log.info(`✓ [${i + 1}/${jobCards.length}] ${job.title} @ ${job.company}`);
      await Dataset.pushData(job);
      jobsScraped++;
    }

    // ── Pagination: try "Load more" or next page ──
    if (jobsScraped < maxJobs && pageNum + 1 < maxPagesPerQuery) {
      const nextPageStart = (pageNum + 1) * 25;
      const nextUrl = buildPaginatedUrls(request.url, nextPageStart);

      if (nextUrl) {
        await crawler.addRequests([
          {
            url: nextUrl,
            userData: { pageNum: pageNum + 1 },
          },
        ]);
        log.info(`Queued page ${pageNum + 2}: ${nextUrl}`);
      }
    }
  },

  failedRequestHandler({ request, log }) {
    log.error(`Request failed: ${request.url}`);
  },
});

await crawler.run([{ url: startUrl, userData: { pageNum: 0 } }]);

log.info(`✅ Done. Total jobs scraped: ${jobsScraped}`);
await Actor.exit();
