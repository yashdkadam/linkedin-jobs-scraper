import { Actor } from "apify";
import { chromium } from "playwright-chromium";
import { scrapeLinkedInJobs } from "./scraper.js";

await Actor.init();

const input = await Actor.getInput();
const { urls = [], count = 100 } = input;

if (!urls.length) throw new Error("No URLs provided in input!");

console.log(
  `Starting LinkedIn scraper for ${urls.length} URL(s), max ${count} jobs each`,
);

// ✅ Launch browser (NO executablePath override needed in Apify)
const browser = await chromium.launch({
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
  ],
});

// ✅ Better context (anti-bot friendly)
const context = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  locale: "en-US",
  viewport: { width: 1366, height: 768 },
});

// ✅ Set higher timeout globally
context.setDefaultNavigationTimeout(90000);
context.setDefaultTimeout(60000);

const page = await context.newPage();
const dataset = await Actor.openDataset();

for (const url of urls) {
  try {
    console.log(`Navigating to: ${url}`);

    // ✅ FIX: DO NOT use networkidle
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // ✅ Wait for jobs list instead
    await page.waitForSelector(".jobs-search__results-list", {
      timeout: 30000,
    });

    // ✅ Small delay (anti-bot)
    await page.waitForTimeout(3000);

    const jobs = await scrapeLinkedInJobs(page, url, count);

    console.log(`Scraped ${jobs.length} jobs from ${url}`);
    await dataset.pushData(jobs);
  } catch (err) {
    console.error(`Failed to scrape ${url}: ${err.message}`);

    // ❌ Don't kill whole actor for one failure
    await Actor.pushData({
      url,
      error: err.message,
    });
  }
}

await browser.close();
await Actor.exit();
