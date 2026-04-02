import { sleep, parseCount } from './utils.js';

/**
 * Scrolls the jobs list panel to load all lazy-loaded jobs
 */
async function scrollJobsList(page, maxJobs) {
  const listSelector = '.jobs-search__results-list';
  let lastCount = 0;
  let staleRounds = 0;

  while (true) {
    const jobs = await page.$$(listSelector + ' > li');
    const currentCount = jobs.length;

    if (currentCount >= maxJobs) break;
    if (currentCount === lastCount) {
      staleRounds++;
      if (staleRounds >= 3) break; // No new jobs loading
    } else {
      staleRounds = 0;
    }

    lastCount = currentCount;

    // Scroll to bottom of list
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.scrollTop = el.scrollHeight;
    }, listSelector);

    await sleep(1500);
  }
}

/**
 * Extracts job data from a single job card + detail panel
 */
async function extractJobData(page, card) {
  try {
    const id = await card.getAttribute('data-entity-urn')
      .then(v => v?.replace('urn:li:jobPosting:', '') ?? '')
      .catch(() => '');

    const title = await card.$eval('.base-search-card__title', el => el.innerText.trim())
      .catch(() => '');

    const companyName = await card.$eval('.base-search-card__subtitle', el => el.innerText.trim())
      .catch(() => '');

    const companyLinkedinUrl = await card.$eval('.base-search-card__subtitle a', el => el.href)
      .catch(() => '');

    const companyLogo = await card.$eval('.artdeco-entity-image', el => el.src)
      .catch(() => '');

    const location = await card.$eval('.job-search-card__location', el => el.innerText.trim())
      .catch(() => '');

    const link = await card.$eval('a.base-card__full-link', el => el.href)
      .catch(() => '');

    const postedAt = await card.$eval('time', el => el.getAttribute('datetime'))
      .catch(() => '');

    // Click card to load detail panel
    await card.click();
    await sleep(1200);

    const applyUrl = await page.$eval(
      '.jobs-apply-button--top-card a, .apply-button--top-card a',
      el => el.href
    ).catch(() => '');

    const descriptionHtml = await page.$eval(
      '.show-more-less-html__markup',
      el => el.innerHTML.trim()
    ).catch(() => '');

    const descriptionText = await page.$eval(
      '.show-more-less-html__markup',
      el => el.innerText.trim()
    ).catch(() => '');

    const applicantsText = await page.$eval(
      '.num-applicants__caption, .jobs-unified-top-card__applicant-count',
      el => el.innerText.trim()
    ).catch(() => '');

    const seniorityLevel = await page.$eval(
      '.jobs-unified-top-card__job-insight:nth-child(1) span',
      el => el.innerText.trim()
    ).catch(() => '');

    const employmentType = await page.$eval(
      '.jobs-unified-top-card__job-insight:nth-child(2) span',
      el => el.innerText.trim()
    ).catch(() => '');

    const salary = await page.$eval(
      '.jobs-unified-top-card__job-insight--highlight span',
      el => el.innerText.trim()
    ).catch(() => '');

    return {
      id,
      link,
      title,
      companyName,
      companyLinkedinUrl,
      companyLogo,
      location,
      salaryInfo: [salary],
      salary,
      postedAt,
      descriptionHtml,
      descriptionText,
      applicantsCount: parseCount(applicantsText)?.toString() ?? '',
      applyUrl,
      seniorityLevel,
      employmentType,
    };
  } catch (err) {
    console.error('Error extracting job:', err.message);
    return null;
  }
}

/**
 * Main scrape function for one LinkedIn search URL
 */
export async function scrapeLinkedInJobs(page, searchUrl, maxJobs) {
  console.log(`Navigating to: ${searchUrl}`);
  await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 60000 });
  await sleep(2000);

  // Scroll to trigger lazy loading
  await scrollJobsList(page, maxJobs);

  const cards = await page.$$('.jobs-search__results-list > li');
  console.log(`Found ${cards.length} job cards`);

  const results = [];
  const limit = Math.min(cards.length, maxJobs);

  for (let i = 0; i < limit; i++) {
    console.log(`Scraping job ${i + 1}/${limit}`);
    const data = await extractJobData(page, cards[i]);
    if (data) {
      results.push({ ...data, inputUrl: searchUrl });
    }
    await sleep(800); // Polite delay between jobs
  }

  return results;
}