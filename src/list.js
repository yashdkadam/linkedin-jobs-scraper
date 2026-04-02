export const handleList = async ({ page, requestQueue, log }) => {
  await page.waitForSelector(".jobs-search__results-list");

  const links = await page.$$eval("a.base-card__full-link", (els) =>
    els.map((el) => el.href),
  );

  log.info(`Found ${links.length} jobs`);

  for (const link of links) {
    await requestQueue.addRequest({
      url: link,
      label: "DETAIL",
    });
  }

  // PAGINATION
  const next = await page.$('button[aria-label="Next"]');
  if (next) {
    await next.click();
    await page.waitForTimeout(2000);

    await requestQueue.addRequest({
      url: page.url(),
      label: "LIST",
    });
  }
};
