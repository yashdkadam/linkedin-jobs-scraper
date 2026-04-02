import { Actor, log as actorLog } from "apify";
import { PlaywrightCrawler, Dataset, sleep } from "crawlee";
import { chromium } from "playwright";
import { extractJobDetails, buildPaginatedUrls } from "./utils.js";

await Actor.init();

const input = (await Actor.getInput()) ?? {};

const {
  startUrl = "https://www.linkedin.com/jobs/search/?f_E=1%2C2%2C3&f_F=it%2Ceng&f_TPR=r86400&geoId=102713980&location=India&sortBy=R",
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
  requestHandlerTimeoutSecs: 180,

  async requestHandler({ page, request, log }) {
    log.info(`Processing: ${request.url}`);

    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    const LIST_SELECTOR =
      "ul.jobs-search__results-list, .scaffold-layout__list-container";
    await page.waitForSelector(LIST_SELECTOR, { timeout: 30_000 });
    await sleep(2000);

    const pageNum = request.userData?.pageNum ?? 0;
    log.info(`Scraping page ${pageNum + 1}...`);

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

    /**
     * BUG FIX: getCardId previously used card.getAttribute() which is a
     * Playwright node-side API returning Promise<string|null>. When the
     * attribute is absent it resolves to null — the .catch() branch never
     * fires — so every card got id=null, making `id && ...` always false,
     * and no card was ever selected.
     *
     * Fix: run via page.evaluate(fn, el) so the read happens inside the
     * browser where element attributes are always accessible.
     */
    const getCardId = (card) =>
      page
        .evaluate((el) => {
          const jobId = el.getAttribute("data-job-id");
          if (jobId) return jobId;
          const anchor = el.querySelector('a[href*="/jobs/view/"]');
          if (anchor) {
            const m = anchor.href.match(/\/jobs\/view\/(\d+)/);
            return m ? m[1] : anchor.href;
          }
          return el.innerText?.trim().slice(0, 80) ?? null;
        }, card)
        .catch(() => null);

    const processedIds = new Set();
    let noNewCardsStreak = 0;
    const MAX_NO_NEW_STREAK = 5;

    while (jobsScraped < maxJobs) {
      const domCards = await page.$$(CARD_SELECTOR);

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

      if (!targetCard) {
        noNewCardsStreak++;
        if (noNewCardsStreak >= MAX_NO_NEW_STREAK) {
          log.info("No new cards after scrolling — reached end of list.");
          break;
        }
        log.info(
          `No new cards in DOM (streak ${noNewCardsStreak}/${MAX_NO_NEW_STREAK}), scrolling…`,
        );
        const lastCard = domCards[domCards.length - 1];
        if (lastCard) await lastCard.scrollIntoViewIfNeeded();
        await sleep(1500);
        continue;
      }

      noNewCardsStreak = 0;
      processedIds.add(targetId);

      const cardLink = await targetCard
        .$eval(
          'a.base-card__full-link, a.job-card-list__title, a[href*="/jobs/view/"]',
          (el) => el.href,
        )
        .catch(() => null);

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
        log.warning(`Could not click card id=${targetId}: ${err.message}`);
        continue;
      }

      try {
        await page.waitForSelector(DETAIL_PANEL_SELECTOR, { timeout: 15_000 });
      } catch {
        log.warning(`Detail panel did not load for id=${targetId}, skipping.`);
        continue;
      }

      await sleep(delayBetweenJobsMs);

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

    if (jobsScraped < maxJobs && pageNum + 1 < maxPagesPerQuery) {
      const nextPageStart = (pageNum + 1) * 25;
      const nextUrl = buildPaginatedUrls(request.url, nextPageStart);
      if (nextUrl) {
        await crawler.addRequests([
          { url: nextUrl, userData: { pageNum: pageNum + 1 } },
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

// FIX: `log` only exists inside requestHandler scope — use actorLog at module level
actorLog.info(`✅ Done. Total jobs scraped: ${jobsScraped}`);
await Actor.exit();
