import { fetchAshbyJobs } from "./ashby.js";
import { fetchApplyToJobJobs } from "./applytojob.js";
import { fetchApplicantProJobs } from "./applicantpro.js";
import { fetchCareerPageJobs } from "./careerpage.js";
import { fetchGreenhouseJobs } from "./greenhouse.js";
import { fetchICimsJobs } from "./icims.js";
import { fetchJobviteJobs } from "./jobvite.js";
import { fetchLeverJobs } from "./lever.js";
import { fetchRecruiteeJobs } from "./recruitee.js";
import { fetchSmartRecruitersJobs } from "./smartrecruiters.js";
import { fetchTaleoJobs } from "./taleo.js";
import { fetchUltiProJobs } from "./ultipro.js";
import { fetchWorkableJobs } from "./workable.js";
import { fetchWorkdayJobs } from "./workday.js";

export const PROVIDER_LABELS = {
  applytojob: "ApplyToJob",
  applicantpro: "ApplicantPro",
  ashby: "Ashby",
  careerpage: "Career Page",
  greenhouse: "Greenhouse",
  icims: "iCIMS",
  jobvite: "Jobvite",
  lever: "Lever",
  recruitee: "Recruitee",
  smartrecruiters: "SmartRecruiters",
  taleo: "Taleo",
  ultipro: "UltiPro / UKG",
  workable: "Workable",
  workday: "Workday",
};

const providerMap = {
  applytojob: fetchApplyToJobJobs,
  applicantpro: fetchApplicantProJobs,
  ashby: fetchAshbyJobs,
  careerpage: fetchCareerPageJobs,
  greenhouse: fetchGreenhouseJobs,
  icims: fetchICimsJobs,
  jobvite: fetchJobviteJobs,
  lever: fetchLeverJobs,
  recruitee: fetchRecruiteeJobs,
  smartrecruiters: fetchSmartRecruitersJobs,
  taleo: fetchTaleoJobs,
  ultipro: fetchUltiProJobs,
  workable: fetchWorkableJobs,
  workday: fetchWorkdayJobs,
};

export async function fetchJobsForSource(source, filters = {}) {
  const provider = providerMap[source.provider];
  if (!provider) {
    throw new Error(`Unsupported provider: ${source.provider}`);
  }

  return provider(source, filters);
}
