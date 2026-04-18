import { fetchHostedBoardJobs } from "./hosted-board.js";

export async function fetchSaphrcloudJobs(source, filters = {}) {
  return fetchHostedBoardJobs(source, filters);
}
