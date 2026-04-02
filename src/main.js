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

    // ── Wait for job list (covers both public + logged-in LinkedIn layouts) ──
    const LIST_SELECTOR =
      "ul.jobs-search__results-list, .scaffold-layout__list-container";
    await page.waitForSelector(LIST_SELECTOR, { timeout: 30_000 });
    await sleep(2000);

    const pageNum = request.userData?.pageNum ?? 0;
    log.info(`Scraping page ${pageNum + 1}...`);

    /**
     * VIRTUAL LIST STRATEGY
     * ─────────────────────
     * LinkedIn renders only ~30-40 cards in the DOM at any time.
     * As you scroll, old cards are REMOVED and new ones are ADDED.
     * Iterating by index (0..totalCards) breaks past ~40.
     *
     * Fix: track which jobs we've already processed by their job ID
     * (extracted from the card's data-job-id attribute or href).
     * On each loop tick, query the current DOM cards, find the first
     * unprocessed one, click it, then scroll to reveal more.
     */

    const CARD_SELECTOR = [
      "ul.jobs-search__results-list > li",
      ".scaffold-layout__list-container .job-card-container",
    ].join(", ");

    const DETAIL_PANEL_SELECTOR = [
      ".show-more-less-html__markup",
      ".job-view-layout",
      ".details-pane__content",
      ".jobs-description",
      ".job-details-jobs-unified-top-card__job-title",
    ].join(", ");

    // Helper: extract a stable ID from a card element
    const getCardId = async (card) => {
      return card
        .getAttribute("data-job-id")
        .catch(() =>
          card
            .$eval(
              'a[href*="/jobs/view/"]',
              (a) => a.href.match(/\/jobs\/view\/(\d+)/)?.[1] ?? a.href,
            )
            .catch(() => null),
        );
    };

    const processedIds = new Set();
    let noNewCardsStreak = 0;
    const MAX_NO_NEW_STREAK = 5; // stop if 5 scroll attempts yield nothing new

    while (jobsScraped < maxJobs) {
      // Query whatever cards are currently in the DOM
      const domCards = await page.$$(CARD_SELECTOR);

      // Find the first card we haven't processed yet
      let targetCard = null;
      let targetId = null;
      for (const card of domCards) {
        const id = await getCardId(card);
        if (id && !processedIds.has(id)) {
          targetCard = card;
          targetId = id;
          break;
        }
      }

      // No unprocessed card visible → scroll down to reveal more
      if (!targetCard) {
        noNewCardsStreak++;
        if (noNewCardsStreak >= MAX_NO_NEW_STREAK) {
          log.info("No new cards after scrolling — reached end of list.");
          break;
        }
        log.info(
          `No new cards in DOM (streak ${noNewCardsStreak}/${MAX_NO_NEW_STREAK}), scrolling…`,
        );
        // Scroll the last visible card into view to trigger LinkedIn's lazy load
        const lastCard = domCards[domCards.length - 1];
        if (lastCard) await lastCard.scrollIntoViewIfNeeded();
        await sleep(1500);
        continue;
      }

      noNewCardsStreak = 0;
      processedIds.add(targetId);

      // ── Grab fallback href before clicking ──
      const cardLink = await targetCard
        .$eval(
          'a.base-card__full-link, a.job-card-list__title, a[href*="/jobs/view/"]',
          (el) => el.href,
        )
        .catch(() => null);

      // ── Scroll into view, then click (JS fallback if overlaid) ──
      try {
        await targetCard.scrollIntoViewIfNeeded();
        await sleep(300);
        await targetCard.click({ timeout: 5000 }).catch(async () => {
          const anchor =
            (await targetCard.$(
              'a.base-card__full-link, a[href*="/jobs/view/"]',
            )) ?? targetCard;
          await anchor.dispatchEvent("click");
        });
      } catch (err) {
        log.warning(`Could not click card (id=${targetId}): ${err.message}`);
        continue;
      }

      // ── Wait for right panel to load ──
      try {
        await page.waitForSelector(DETAIL_PANEL_SELECTOR, { timeout: 15_000 });
      } catch {
        log.warning(`Detail panel did not load for id=${targetId}, skipping.`);
        continue;
      }

      await sleep(delayBetweenJobsMs);

      // ── Extract ──
      const job = await page.evaluate(extractJobDetails).catch((err) => {
        log.warning(`Extraction failed for id=${targetId}: ${err.message}`);
        return null;
      });

      if (!job) continue;
      if (!job.link && cardLink) job.link = cardLink;

      log.info(`✓ [${jobsScraped + 1}] ${job.title} @ ${job.company}`);
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
