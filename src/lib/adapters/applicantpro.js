import { fetchHostedBoardJobs } from "./hosted-board.js";

export async function fetchApplicantProJobs(source) {
  return fetchHostedBoardJobs(source);
}