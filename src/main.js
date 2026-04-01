import { Actor } from "apify";
import { chromium } from "playwright";
import { scrapeLinkedInJobs } from "./scraper.js";

await Actor.init();

const input = await Actor.getInput();
const { urls = [], count = 100, scrapeCompany = false } = input;

if (!urls.length) {
  throw new Error("No URLs provided in input!");
}

console.log(
  `Starting LinkedIn scraper for ${urls.length} URL(s), max ${count} jobs each`,
);

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

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
