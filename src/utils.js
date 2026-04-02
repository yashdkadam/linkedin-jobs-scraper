/**
 * Runs inside the browser page via page.evaluate().
 * Reads the currently-active detail panel on the right side.
 */
export function extractJobDetails() {
  const getText = (selectors) => {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el.innerText?.trim() ?? el.textContent?.trim() ?? "";
    }
    return "";
  };

  const getHref = (selectors) => {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el?.href) return el.href;
    }
    return "";
  };

  // ── Title ──
  const title = getText([
    ".top-card-layout__title",
    ".topcard__title",
    ".job-details-jobs-unified-top-card__job-title h1",
    ".jobs-unified-top-card__job-title",
    "h1.t-24",
    "[data-test-job-title]",
  ]);

  // ── Company ──
  const company = getText([
    ".topcard__org-name-link",
    ".top-card-layout__company a",
    ".jobs-unified-top-card__company-name a",
    ".job-details-jobs-unified-top-card__company-name a",
    ".jobs-unified-top-card__company-name",
    "[data-test-employer-name]",
  ]);

  // ── Location ──
  const location = getText([
    ".topcard__flavor--bullet",
    ".jobs-unified-top-card__bullet",
    ".job-details-jobs-unified-top-card__primary-description-without-tagline span.tvm__text",
    ".jobs-unified-top-card__workplace-type",
    "[data-test-job-location]",
    ".top-card-layout__first-subline span",
  ]);

  // ── Description ──
  // LinkedIn hides full description behind "Show more" button.
  // We grab what's visible in the markup div.
  const descSelectors = [
    ".show-more-less-html__markup",
    ".jobs-description-content__text",
    ".job-view-layout .description__text",
    ".jobs-box__html-content",
    "[data-test-job-description]",
  ];
  let description = "";
  for (const sel of descSelectors) {
    const el = document.querySelector(sel);
    if (el) {
      description = el.innerText?.trim() ?? "";
      break;
    }
  }

  // ── Link ──
  const link =
    getHref([
      ".top-card-layout__title a",
      ".topcard__link",
      ".job-details-jobs-unified-top-card__job-title a",
      ".jobs-unified-top-card__job-title a",
      "a.job-card-list__title",
    ]) || window.location.href;

  // ── Employment type / seniority (bonus fields) ──
  const employmentType = getText([
    ".jobs-unified-top-card__job-insight span",
    ".description__job-criteria-text",
  ]);

  return {
    title: title || null,
    company: company || null,
    location: location || null,
    description: description || null,
    link: link || null,
    employmentType: employmentType || null,
    scrapedAt: new Date().toISOString(),
  };
}

/**
 * Appends/replaces the `start` query param to paginate LinkedIn results.
 * LinkedIn paginates in steps of 25.
 * @param {string} baseUrl
 * @param {number} start  – e.g. 25 for page 2, 50 for page 3
 * @returns {string|null}
 */
export function buildPaginatedUrls(baseUrl, start) {
  try {
    const url = new URL(baseUrl);
    url.searchParams.set("start", String(start));
    // Remove currentJobId so the page doesn't lock to a single job
    url.searchParams.delete("currentJobId");
    return url.toString();
  } catch {
    return null;
  }
}
