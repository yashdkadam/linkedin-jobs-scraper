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

    // ── Wait for job list (try both logged-in and public selectors) ──
    const LIST_SELECTOR =
      "ul.jobs-search__results-list, .scaffold-layout__list-container";
    await page.waitForSelector(LIST_SELECTOR, { timeout: 30_000 });
    await sleep(2000); // let lazy-loaded cards render

    const pageNum = request.userData?.pageNum ?? 0;
    log.info(`Scraping page ${pageNum + 1}...`);

    // ── Count cards once (just for logging) ──
    // We do NOT store handles — they go stale after LinkedIn re-renders the list
    const CARD_SELECTOR =
      "ul.jobs-search__results-list > li, .scaffold-layout__list-container .job-card-container";
    const totalCards = await page.$$eval(CARD_SELECTOR, (els) => els.length);
    log.info(`Found ${totalCards} job cards`);

    for (let i = 0; i < totalCards; i++) {
      if (jobsScraped >= maxJobs) {
        log.info(`Reached maxJobs limit (${maxJobs}). Stopping.`);
        return;
      }

      // ── Re-query the nth card fresh on every iteration (avoids stale handles) ──
      const cards = await page.$$(CARD_SELECTOR);
      const card = cards[i];
      if (!card) {
        log.warning(`Card ${i + 1} not found after re-query, skipping.`);
        continue;
      }

      // ── Grab the fallback link from the card before clicking ──
      const cardLink = await card
        .$eval(
          "a.base-card__full-link, a.job-card-list__title, a[data-tracking-control-name]",
          (el) => el.href,
        )
        .catch(() => null);

      // ── Scroll into view then click via JS (bypasses overlay issues) ──
      try {
        await card.scrollIntoViewIfNeeded();
        await sleep(300);

        // Try native Playwright click first, fall back to JS click
        await card.click({ timeout: 5000 }).catch(async () => {
          const clickable =
            (await card.$(
              "a.base-card__full-link, a.job-card-list__title, .job-card-container__link",
            )) ?? card;
          await clickable.dispatchEvent("click");
        });
      } catch (err) {
        log.warning(`Could not click card ${i + 1}: ${err.message}`);
        continue;
      }

      // ── Wait for the right-side detail panel to reflect the new job ──
      try {
        await page.waitForSelector(
          [
            ".show-more-less-html__markup",
            ".job-view-layout",
            ".details-pane__content",
            ".jobs-description",
            ".job-details-jobs-unified-top-card__job-title",
          ].join(", "),
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

      if (!job.link && cardLink) job.link = cardLink;

      log.info(`✓ [${i + 1}/${totalCards}] ${job.title} @ ${job.company}`);
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
