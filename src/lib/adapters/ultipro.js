import { fetchHostedBoardJobs } from "./hosted-board.js";

export async function fetchUltiProJobs(source) {
  return fetchHostedBoardJobs(source);
}