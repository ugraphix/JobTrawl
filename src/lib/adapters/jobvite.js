import { fetchHostedBoardJobs } from "./hosted-board.js";

export async function fetchJobviteJobs(source) {
  const careersUrl = source.site
    ? `https://jobs.jobvite.com/${source.site}/jobs/alljobs`
    : source.careersUrl;
  return fetchHostedBoardJobs({ ...source, careersUrl });
}
