import { fetchHostedBoardJobs } from "./hosted-board.js";

export async function fetchCareerPageJobs(source, filters = {}) {
  return fetchHostedBoardJobs(source, filters);
}
