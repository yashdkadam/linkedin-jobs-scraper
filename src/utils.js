import { Actor } from "apify";

await Actor.init();

const queries = [
  "software engineer india",
  "backend developer india",
  "frontend developer india",
  "java developer india",
  "python developer india",
];

for (const q of queries) {
  const url = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(q)}&location=India`;

  await Actor.call("YOUR_WORKER", {
    startUrls: [url],
    maxJobs: 2000,
  });
}

await Actor.exit();
