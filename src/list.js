export const handleList = async ({ page, enqueueLinks, log }) => {
  await page.waitForSelector(".jobs-search__results-list");

  log.info("Scraping LIST page");

  // scroll to load jobs
  await page.evaluate(async () => {
    const scrollable = document.querySelector(".jobs-search__results-list");
    for (let i = 0; i < 10; i++) {
      scrollable.scrollBy(0, 1000);
      await new Promise((r) => setTimeout(r, 800));
    }
  });

  const count = await page.$$eval(
    ".jobs-search__results-list li",
    (els) => els.length,
  );

  log.info(`Found ${count} jobs`);

  await enqueueLinks({
    selector: "a.base-card__full-link",
    label: "DETAIL",
  });
};
