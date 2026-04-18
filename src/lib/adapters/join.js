import { fetchHostedBoardJobs } from "./hosted-board.js";

export async function fetchJoinJobs(source, filters = {}) {
  return fetchHostedBoardJobs(source, filters);
}
