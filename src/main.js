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
    const { label } = request.userData;

    // 🔥 HUMAN-LIKE DELAY
    await page.waitForTimeout(200 + Math.random() * 200);

    // =========================
    // 📄 LIST PAGE
    // =========================
    if (label === "LIST") {
      log.info(`LIST: ${request.url}`);

      await page.waitForLoadState("domcontentloaded");

      await page.waitForSelector(".jobs-search__results-list", {
        timeout: 3000,
      });

      // 🔽 Scroll to load jobs
      let prevCount = 0;

      for (let i = 0; i < 10; i++) {
        await page.evaluate(() =>
          window.scrollTo(0, document.body.scrollHeight),
        );
        await page.waitForTimeout(120);

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
          await page.waitForTimeout(250);

          await requestQueue.addRequest({
            url: page.url(),
            userData: { label: "LIST" },
          });
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

      await page.waitForTimeout(500);

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
