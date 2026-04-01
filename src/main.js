import { Actor } from "apify";
import { PlaywrightCrawler, Dataset, RequestQueue } from "crawlee";

await Actor.init();

const input = await Actor.getInput();
const { urls = [], count = 1000 } = input;

const seen = new Set();
const requestQueue = await RequestQueue.open();

// seed URLs
for (const url of urls) {
  await requestQueue.addRequest({
    url,
    userData: { label: "LIST" },
  });
}

const crawler = new PlaywrightCrawler({
  requestQueue,

  proxyConfiguration: await Actor.createProxyConfiguration({
    useApifyProxy: true,
    groups: ["RESIDENTIAL"], // 🔥 much harder to block
  }),

  // ⚡ HIGH PARALLELISM (use your infra)
  maxConcurrency: 50,

  requestHandlerTimeoutSecs: 120,

  launchContext: {
    launchOptions: {
      headless: true,
      executablePath: "/usr/bin/google-chrome-stable",
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    },
  },

  useSessionPool: true,
  maxRequestRetries: 2,

  async requestHandler({ page, request, log }) {
    const { label } = request.userData;

    // ================= LIST =================
    if (label === "LIST") {
      await page.waitForLoadState("domcontentloaded");

      await page.waitForSelector(".jobs-search__results-list", {
        timeout: 30000,
      });

      // ⚡ fast scroll (reduced loops)
      for (let i = 0; i < 10; i++) {
        await page.evaluate(() =>
          window.scrollTo(0, document.body.scrollHeight),
        );
        await page.waitForTimeout(1000);
      }

      // extract links
      let links = await page.$$eval(".jobs-search__results-list li a", (as) =>
        as.map((a) => a.href),
      );

      // ✅ remove junk links (authwall fix)
      links = links.filter(
        (l) => l && !l.includes("authwall") && l.includes("/jobs/view/"),
      );

      log.info(`Valid links: ${links.length}`);

      // enqueue detail pages
      for (const link of links) {
        if (!seen.has(link) && seen.size < count) {
          seen.add(link);

          await requestQueue.addRequest({
            url: link,
            userData: { label: "DETAIL" },
          });
        }
      }

      // 🔥 pagination (robust)
      const nextBtn = await page.$('button[aria-label="Next"]');

      if (nextBtn) {
        const disabled = await nextBtn.isDisabled();

        if (!disabled) {
          await nextBtn.click();
          await page.waitForTimeout(2000);

          await requestQueue.addRequest({
            url: page.url(),
            userData: { label: "LIST" },
          });
        }
      }
    }

    // ================= DETAIL =================
    else if (label === "DETAIL") {
      await page.waitForLoadState("domcontentloaded");

      // ⚡ fail fast if redirected
      if (page.url().includes("authwall")) {
        log.warning("Blocked → skipping");
        return;
      }

      // ⚡ small wait (not too long)
      await page.waitForTimeout(1000);

      const job = await page.evaluate(() => {
        const get = (s) => document.querySelector(s)?.innerText?.trim() || null;

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

      // ✅ skip empty junk
      if (!job.title) return;

      await Dataset.pushData(job);
    }
  },
});

await crawler.run();
await Actor.exit();
