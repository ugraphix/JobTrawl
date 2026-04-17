import { fetchHostedBoardJobs } from "./hosted-board.js";

export async function fetchApplyToJobJobs(source) {
  return fetchHostedBoardJobs(source);
}