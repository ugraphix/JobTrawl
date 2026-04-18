import { fetchHostedBoardJobs } from "./hosted-board.js";

export async function fetchGemJobs(source, filters = {}) {
  return fetchHostedBoardJobs(source, filters);
}
