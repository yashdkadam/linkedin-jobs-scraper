import { Dataset } from "crawlee";

export const handleDetail = async ({ page, request, log }) => {
  try {
    await page.waitForSelector(".top-card-layout__title", { timeout: 10000 });

    const data = await page.evaluate(() => ({
      title: document.querySelector(".top-card-layout__title")?.innerText,
      company: document.querySelector(".topcard__org-name-link")?.innerText,
      location: document.querySelector(".topcard__flavor--bullet")?.innerText,
      description: document.querySelector(".description__text")?.innerText,
      link: window.location.href,
    }));

    log.info(`✓ ${data.title}`);

    await Dataset.pushData(data);
  } catch (err) {
    log.warning(`❌ Failed detail: ${request.url}`);
  }
};
