export const handleDetail = async ({ page, request, pushData, log }) => {
  try {
    await page.waitForSelector("h1", { timeout: 5000 });

    const data = await page.evaluate(() => {
      const getText = (sel) =>
        document.querySelector(sel)?.innerText.trim() || "";

      return {
        title: getText("h1"),
        company: getText(".topcard__org-name-link"),
        location: getText(".topcard__flavor--bullet"),
        description: getText(".show-more-less-html__markup"),
      };
    });

    data.link = request.url;

    log.info(`✓ ${data.title}`);

    await pushData(data);

    // HUMAN-LIKE DELAY
    await page.waitForTimeout(1000 + Math.random() * 2000);
  } catch (err) {
    log.warning(`Retrying: ${request.url}`);
    throw err;
  }
};
