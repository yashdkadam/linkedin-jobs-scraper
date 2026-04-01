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

const browser = await chromium.launch({
  headless: true,
  // ✅ Use the Chromium already installed in the Apify Docker image
  executablePath:
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
    "/usr/bin/google-chrome-stable" || // fallback for Apify's base image
    undefined, // fallback to Playwright default
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage", // ✅ prevents crashes in Docker
    "--disable-gpu",
  ],
});

// ... rest of your code unchanged

const context = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  locale: "en-US",
});

const page = await context.newPage();
const dataset = await Actor.openDataset();

for (const url of urls) {
  try {
    const jobs = await scrapeLinkedInJobs(page, url, count);
    console.log(`Scraped ${jobs.length} jobs from ${url}`);
    await dataset.pushData(jobs);
  } catch (err) {
    console.error(`Failed to scrape ${url}: ${err.message}`);
    await Actor.fail(`Scraping failed: ${err.message}`);
  }
}

await browser.close();
await Actor.exit();
