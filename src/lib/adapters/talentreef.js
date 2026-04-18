import { fetchHostedBoardJobs } from "./hosted-board.js";

export async function fetchTalentReefJobs(source, filters = {}) {
  return fetchHostedBoardJobs(source, filters);
}
