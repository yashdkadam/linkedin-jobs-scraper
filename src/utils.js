/**
 * Safely extract text from a DOM element
 */
export function getText(page, selector) {
  return page.$eval(selector, (el) => el.innerText.trim()).catch(() => "");
}

/**
 * Extract number from strings like "200 applicants"
 */
export function parseCount(str) {
  if (!str) return null;
  const match = str.match(/[\d,]+/);
  return match ? parseInt(match[0].replace(/,/g, ""), 10) : null;
}

/**
 * Build a unique tracking ID for deduplication
 */
export function makeJobId(url) {
  const match = url.match(/\/(\d{10,})/);
  return match ? match[1] : null;
}

/**
 * Sleep for ms milliseconds
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
