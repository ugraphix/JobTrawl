import { fetchAshbyJobs } from "./ashby.js";
import { fetchApplyToJobJobs } from "./applytojob.js";
import { fetchApplicantProJobs } from "./applicantpro.js";
import { fetchApplicantAiJobs } from "./applicantai.js";
import { fetchCareerPageJobs } from "./careerpage.js";
import { fetchBreezyJobs } from "./breezy.js";
import { fetchBambooHrJobs } from "./bamboohr.js";
import { fetchCareerPlugJobs } from "./careerplug.js";
import { fetchCareerPuckJobs } from "./careerpuck.js";
import { fetchFountainJobs } from "./fountain.js";
import { fetchGemJobs } from "./gem.js";
import { fetchGreenhouseJobs } from "./greenhouse.js";
import { fetchGetroJobs } from "./getro.js";
import { fetchHrmDirectJobs } from "./hrmdirect.js";
import { fetchICimsJobs } from "./icims.js";
import { fetchJoinJobs } from "./join.js";
import { fetchJobApsJobs } from "./jobaps.js";
import { fetchJobviteJobs } from "./jobvite.js";
import { fetchLeverJobs } from "./lever.js";
import { fetchManatalJobs } from "./manatal.js";
import { fetchRecruiteeJobs } from "./recruitee.js";
import { fetchSaphrcloudJobs } from "./saphrcloud.js";
import { fetchSlalomJobs } from "./slalom.js";
import { fetchSmartRecruitersJobs } from "./smartrecruiters.js";
import { fetchTaleoJobs } from "./taleo.js";
import { fetchTalentlyftJobs } from "./talentlyft.js";
import { fetchTalexioJobs } from "./talexio.js";
import { fetchTalentReefJobs } from "./talentreef.js";
import { fetchTeamtailorJobs } from "./teamtailor.js";
import { fetchTheApplicantManagerJobs } from "./theapplicantmanager.js";
import { fetchUltiProJobs } from "./ultipro.js";
import { fetchWorkableJobs } from "./workable.js";
import { fetchWorkdayJobs } from "./workday.js";
import { fetchZohoJobs } from "./zoho.js";

export const PROVIDER_LABELS = {
  applytojob: "ApplyToJob",
  applicantpro: "ApplicantPro",
  applicantai: "ApplicantAI",
  ashby: "Ashby",
  bamboohr: "BambooHR",
  breezy: "BreezyHR",
  careerpage: "Career Page",
  careerplug: "Career Plug",
  careerpuck: "Career Puck",
  fountain: "Fountain",
  gem: "Gem",
  getro: "Getro",
  greenhouse: "Greenhouse",
  hrmdirect: "HRM Direct",
  icims: "iCIMS",
  join: "JOIN",
  jobaps: "Jobaps",
  jobvite: "Jobvite",
  lever: "Lever",
  manatal: "Manatal",
  recruitee: "Recruitee",
  saphrcloud: "Saphrcloud",
  slalom: "Slalom Careers",
  smartrecruiters: "SmartRecruiters",
  taleo: "Taleo",
  talentreef: "Talent Reef",
  talentlyft: "Talent Lyft",
  talexio: "Talexio",
  teamtailor: "Team Tailor",
  theapplicantmanager: "The Applicant Manager",
  ultipro: "UltiPro / UKG",
  workable: "Workable",
  workday: "Workday",
  zoho: "Zoho Recruit",
};

const providerMap = {
  applytojob: fetchApplyToJobJobs,
  applicantpro: fetchApplicantProJobs,
  applicantai: fetchApplicantAiJobs,
  ashby: fetchAshbyJobs,
  bamboohr: fetchBambooHrJobs,
  breezy: fetchBreezyJobs,
  careerpage: fetchCareerPageJobs,
  careerplug: fetchCareerPlugJobs,
  careerpuck: fetchCareerPuckJobs,
  fountain: fetchFountainJobs,
  gem: fetchGemJobs,
  getro: fetchGetroJobs,
  greenhouse: fetchGreenhouseJobs,
  hrmdirect: fetchHrmDirectJobs,
  icims: fetchICimsJobs,
  join: fetchJoinJobs,
  jobaps: fetchJobApsJobs,
  jobvite: fetchJobviteJobs,
  lever: fetchLeverJobs,
  manatal: fetchManatalJobs,
  recruitee: fetchRecruiteeJobs,
  saphrcloud: fetchSaphrcloudJobs,
  slalom: fetchSlalomJobs,
  smartrecruiters: fetchSmartRecruitersJobs,
  taleo: fetchTaleoJobs,
  talentreef: fetchTalentReefJobs,
  talentlyft: fetchTalentlyftJobs,
  talexio: fetchTalexioJobs,
  teamtailor: fetchTeamtailorJobs,
  theapplicantmanager: fetchTheApplicantManagerJobs,
  ultipro: fetchUltiProJobs,
  workable: fetchWorkableJobs,
  workday: fetchWorkdayJobs,
  zoho: fetchZohoJobs,
};

export async function fetchJobsForSource(source, filters = {}) {
  const provider = providerMap[source.provider];
  if (!provider) {
    throw new Error(`Unsupported provider: ${source.provider}`);
  }

  return provider(source, filters);
}
