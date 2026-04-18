export const RECENCY_WINDOWS = {
  "24h": 24 * 60 * 60 * 1000,
  "3d": 3 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "14d": 14 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export const DISTANCE_OPTIONS = [3, 5, 10, 15, 20];

const KEYWORD_ALIASES = {
  "product manager": ["product manager", "product owner", "product lead"],
  "technical program manager": ["technical program manager", "tpm", "program manager"],
  "program manager": ["program manager", "project manager"],
  "project manager": ["project manager", "delivery manager"],
  "product operations": ["product operations", "product ops", "product operations manager"],
  "business operations": ["business operations", "biz ops", "business operations manager", "strategy and operations"],
  "software engineer": ["software engineer", "software developer", "application engineer"],
  "frontend engineer": ["frontend engineer", "frontend developer", "ui engineer"],
  "backend engineer": ["backend engineer", "backend developer", "api engineer"],
  "full stack engineer": ["full stack engineer", "fullstack developer"],
  "mobile engineer": ["mobile engineer", "ios developer", "android developer", "mobile developer"],
  "data engineer": ["data engineer", "etl engineer"],
  "devops engineer": ["devops engineer", "devops", "platform engineer", "sre"],
  "qa engineer": ["qa engineer", "qa tester", "test engineer", "quality assurance"],
  "data analyst": ["data analyst", "business analyst", "insights analyst"],
  "product analyst": ["product analyst"],
  "data scientist": ["data scientist", "machine learning scientist"],
  "analytics engineer": ["analytics engineer"],
  "product designer": ["product designer", "ux designer"],
  "ux designer": ["ux designer", "user experience designer"],
  "ui designer": ["ui designer", "user interface designer"],
  "ux researcher": ["ux researcher", "user researcher"],
  "marketing manager": ["marketing manager", "brand manager"],
  "growth marketing": ["growth marketing", "growth marketer", "growth manager"],
  "performance marketing": ["performance marketing", "paid media", "acquisition manager"],
  "content marketing": ["content marketing", "content strategist", "content manager"],
  "social media manager": ["social media manager", "social media strategist"],
  "account executive": ["account executive", "sales executive", "account manager sales"],
  "sales manager": ["sales manager", "sales lead", "sales director"],
  "customer success manager": ["customer success manager", "csm", "client success manager"],
  "customer support": ["customer support", "support specialist", "customer service rep"],
  receptionist: [
    "receptionist",
    "medical receptionist",
    "front desk",
    "front desk agent",
    "front desk coordinator",
    "medical support assistant",
    "patient services representative",
    "patient access representative",
    "guest services",
  ],
  reception: [
    "reception",
    "receptionist",
    "medical receptionist",
    "front desk",
    "front desk agent",
    "front desk coordinator",
    "medical support assistant",
    "patient services representative",
    "patient access representative",
    "guest services",
  ],
  "office manager": ["office manager", "office administrator", "practice manager"],
  "administrative assistant": ["administrative assistant", "admin assistant", "executive assistant"],
  "operations manager": ["operations manager", "ops manager", "operations lead"],
  "registered nurse": ["registered nurse", "rn", "staff nurse"],
  "medical assistant": ["medical assistant", "ma", "clinical assistant"],
  "nurse practitioner": ["nurse practitioner", "np"],
  "physician assistant": ["physician assistant", "pa"],
  "care coordinator": ["care coordinator", "patient coordinator"],
  "patient coordinator": [
    "patient coordinator",
    "patient care coordinator",
    "patient services coordinator",
    "patient service coordinator",
    "patient access coordinator",
    "patient access services coordinator",
    "patient accounts coordinator",
    "patient throughput coordinator",
    "patient flow coordinator",
    "new patient coordinator",
    "service agent patient care coordinator",
  ],
  chef: ["chef", "sous chef", "line cook", "cook"],
  server: ["server", "waiter", "waitress", "food server"],
  barista: ["barista", "coffee specialist"],
  bartender: ["bartender", "mixologist"],
  janitor: ["janitor", "custodian", "housekeeper", "environmental services"],
  "maintenance technician": ["maintenance technician", "maintenance worker", "facilities technician", "maintenance mechanic", "facilities tech"],
  accountant: ["accountant", "staff accountant", "senior accountant"],
  "financial analyst": ["financial analyst", "finance analyst"],
  controller: ["controller", "finance controller"],
  "legal assistant": ["legal assistant", "paralegal", "legal admin"],
  "video engineer": ["video engineer", "streaming engineer", "media engineer"],
  "streaming engineer": ["streaming engineer", "live streaming engineer", "video streaming engineer"],
  "broadcast engineer": ["broadcast engineer", "broadcast technician"],
  "media operations": ["media operations", "media ops", "broadcast operations", "playout operator"],
  "video operations": ["video operations", "video ops", "streaming operations", "live ops"],
  "content operations": ["content operations", "content ops", "media operations coordinator"],
  "playout operator": ["playout operator", "master control operator", "mcr operator"],
  "master control": ["master control", "master control operator", "broadcast control room"],
  "video editor": ["video editor", "post production editor"],
  "post production": ["post production", "post production specialist", "post producer"],
  "content producer": ["content producer", "digital producer", "segment producer"],
  "technical director": ["technical director", "td", "broadcast technical director"],
  "audio engineer": ["audio engineer", "sound engineer", "audio technician"],
  "camera operator": ["camera operator", "videographer", "camera op"],
  "radio producer": ["radio producer", "show producer", "audio producer"],
  "radio host": ["radio host", "on-air talent", "radio personality"],
  "audio technician": ["audio technician", "sound tech", "audio operator"],
  "podcast producer": ["podcast producer", "podcast editor", "podcast manager"],
  electrician: ["electrician", "journeyman electrician", "apprentice electrician", "electrical technician"],
  "electrical technician": ["electrical technician", "electrical tech", "field service electrician"],
  plumber: ["plumber", "plumbing technician", "pipefitter"],
  pipefitter: ["pipefitter", "steamfitter", "piping technician"],
  "hvac technician": ["hvac technician", "hvac tech", "hvac installer", "hvac mechanic"],
  "sheet metal worker": ["sheet metal worker", "sheet metal mechanic", "fabricator", "metal worker"],
  "metal fabricator": ["metal fabricator", "welder fabricator", "fabrication technician"],
  welder: ["welder", "welding technician", "mig welder", "tig welder"],
  "construction worker": ["construction worker", "laborer", "construction laborer"],
  "general contractor": ["general contractor", "contractor", "construction manager"],
  carpenter: ["carpenter", "finish carpenter", "framing carpenter"],
  foreman: ["foreman", "site supervisor", "crew lead"],
  "field technician": ["field technician", "field service technician", "service tech"],
  "building engineer": ["building engineer", "facilities engineer"],
  cashier: ["cashier", "retail associate", "store associate"],
  "retail associate": ["retail associate", "sales associate", "store associate"],
  "store manager": ["store manager", "retail manager", "shop manager"],
  "shift supervisor": ["shift supervisor", "shift lead", "team lead"],
  "line cook": ["line cook", "prep cook", "kitchen staff"],
  "kitchen manager": ["kitchen manager", "back of house manager"],
  "restaurant manager": ["restaurant manager", "general manager", "gm"],
  "warehouse worker": ["warehouse worker", "warehouse associate", "fulfillment associate"],
  "forklift operator": ["forklift operator", "lift operator", "warehouse driver"],
  "delivery driver": ["delivery driver", "courier", "route driver"],
  "logistics coordinator": ["logistics coordinator", "shipping coordinator", "supply chain coordinator"],
  "truck driver": ["truck driver", "cdl driver", "delivery driver"],
  "bus driver": ["bus driver", "transit operator"],
  "fleet manager": ["fleet manager", "transportation manager"],
  "security guard": ["security guard", "security officer"],
  "loss prevention": ["loss prevention", "asset protection associate"],
  housekeeper: ["housekeeper", "cleaner", "room attendant"],
  "janitorial staff": ["janitorial staff", "custodial staff", "cleaning technician"],
  technician: ["technician", "tech"],
  specialist: ["specialist", "coordinator", "assistant"],
  apprentice: ["apprentice", "journeyman", "senior"],
  teacher: ["teacher", "educator", "instructor", "classroom teacher"],
  "substitute teacher": ["substitute teacher", "sub", "substitute educator"],
  "teaching assistant": ["teaching assistant", "teacher aide", "paraeducator"],
  "school administrator": ["school administrator", "principal", "assistant principal"],
  "academic advisor": ["academic advisor", "student advisor", "counselor"],
  "case manager": ["case manager", "social worker", "case worker"],
  "policy analyst": ["policy analyst", "policy advisor", "policy specialist"],
  "program coordinator": ["program coordinator", "program specialist"],
  "city planner": ["city planner", "urban planner"],
  "program manager nonprofit": ["program manager", "program coordinator", "program director"],
  "development manager": ["development manager", "fundraising manager", "donor relations"],
  "community outreach": ["community outreach", "outreach coordinator", "community manager"],
  recruiter: ["recruiter", "talent acquisition", "talent partner"],
  "hr generalist": ["hr generalist", "people operations", "hr business partner"],
  "hr coordinator": ["hr coordinator", "people ops coordinator"],
  paralegal: ["paralegal", "legal assistant"],
  "legal counsel": ["legal counsel", "attorney", "lawyer"],
  "compliance analyst": ["compliance analyst", "compliance specialist"],
  bookkeeper: ["bookkeeper", "accounting clerk"],
  "payroll specialist": ["payroll specialist", "payroll administrator"],
  "accounts payable": ["accounts payable", "ap specialist"],
  "accounts receivable": ["accounts receivable", "ar specialist"],
  "property manager": ["property manager", "building manager", "community manager"],
  "leasing agent": ["leasing agent", "leasing consultant"],
  "real estate agent": ["real estate agent", "realtor"],
  "claims adjuster": ["claims adjuster", "claims specialist"],
  underwriter: ["underwriter", "insurance underwriter"],
  "insurance agent": ["insurance agent", "insurance sales"],
  "customer experience": ["customer experience", "cx manager", "customer experience manager"],
  "customer operations": ["customer operations", "customer ops", "support operations"],
  "it support": ["it support", "help desk", "desktop support"],
  "system administrator": ["system administrator", "sysadmin", "it admin"],
  "network engineer": ["network engineer", "network admin"],
  "security analyst": ["security analyst", "cybersecurity analyst", "infosec", "soc analyst"],
  "security engineer": ["security engineer", "application security", "cloud security"],
  "penetration tester": ["penetration tester", "pentester", "ethical hacker"],
  "research assistant": ["research assistant", "lab assistant"],
  "research scientist": ["research scientist", "scientist"],
  "lab technician": ["lab technician", "lab tech"],
  "machine operator": ["machine operator", "production operator"],
  "assembly worker": ["assembly worker", "assembler"],
  "production supervisor": ["production supervisor", "production lead"],
  "quality inspector": ["quality inspector", "qc inspector", "quality control"],
  "farm worker": ["farm worker", "agricultural worker"],
  landscaper: ["landscaper", "groundskeeper"],
  arborist: ["arborist", "tree specialist"],
  "hair stylist": ["hair stylist", "cosmetologist"],
  esthetician: ["esthetician", "skincare specialist"],
  "personal trainer": ["personal trainer", "fitness coach"],
  "flight attendant": ["flight attendant", "cabin crew"],
  pilot: ["pilot", "commercial pilot"],
  "travel agent": ["travel agent", "travel advisor"],
  "hotel front desk": ["hotel front desk", "front desk agent"],
  concierge: ["concierge", "guest services"],
  "housekeeping supervisor": ["housekeeping supervisor", "housekeeping manager"],
  "graphic designer": ["graphic designer", "visual designer"],
  "art director": ["art director", "creative director"],
  copywriter: ["copywriter", "content writer"],
  photographer: ["photographer", "photo specialist"],
  contract: ["contract", "contractor", "freelance", "temporary"],
  "part time": ["part time", "part-time", "hourly"],
  gig: ["gig", "independent contractor"],
};

const TITLE_FOCUSED_ALIAS_QUERIES = new Set([
  "product manager",
  "patient coordinator",
  "chef",
  "janitor",
  "reception",
  "receptionist",
]);

const LOCATION_ALIASES = [
  { aliases: ["seattle", "sea"], latitude: 47.6062, longitude: -122.3321 },
  { aliases: ["bellevue"], latitude: 47.6101, longitude: -122.2015 },
  { aliases: ["redmond"], latitude: 47.674, longitude: -122.1215 },
  { aliases: ["kirkland"], latitude: 47.6815, longitude: -122.2087 },
  { aliases: ["tacoma"], latitude: 47.2529, longitude: -122.4443 },
  { aliases: ["everett"], latitude: 47.978, longitude: -122.2021 },
  { aliases: ["san francisco", "sf"], latitude: 37.7749, longitude: -122.4194 },
  { aliases: ["san jose"], latitude: 37.3382, longitude: -121.8863 },
  { aliases: ["mountain view"], latitude: 37.3861, longitude: -122.0839 },
  { aliases: ["palo alto"], latitude: 37.4419, longitude: -122.143 },
  { aliases: ["los angeles", "la"], latitude: 34.0522, longitude: -118.2437 },
  { aliases: ["san diego"], latitude: 32.7157, longitude: -117.1611 },
  { aliases: ["new york city", "new york", "nyc"], latitude: 40.7128, longitude: -74.006 },
  { aliases: ["brooklyn"], latitude: 40.6782, longitude: -73.9442 },
  { aliases: ["queens"], latitude: 40.7282, longitude: -73.7949 },
  { aliases: ["albany"], latitude: 42.6526, longitude: -73.7562 },
  { aliases: ["austin"], latitude: 30.2672, longitude: -97.7431 },
  { aliases: ["dallas"], latitude: 32.7767, longitude: -96.797 },
  { aliases: ["houston"], latitude: 29.7604, longitude: -95.3698 },
  { aliases: ["boston"], latitude: 42.3601, longitude: -71.0589 },
  { aliases: ["cambridge"], latitude: 42.3736, longitude: -71.1097 },
  { aliases: ["chicago"], latitude: 41.8781, longitude: -87.6298 },
  { aliases: ["denver"], latitude: 39.7392, longitude: -104.9903 },
  { aliases: ["boulder"], latitude: 40.015, longitude: -105.2705 },
  { aliases: ["atlanta"], latitude: 33.749, longitude: -84.388 },
  { aliases: ["miami"], latitude: 25.7617, longitude: -80.1918 },
  { aliases: ["tampa"], latitude: 27.9506, longitude: -82.4572 },
  { aliases: ["raleigh"], latitude: 35.7796, longitude: -78.6382 },
  { aliases: ["charlotte"], latitude: 35.2271, longitude: -80.8431 },
  { aliases: ["portland"], latitude: 45.5152, longitude: -122.6784 },
  { aliases: ["philadelphia"], latitude: 39.9526, longitude: -75.1652 },
  { aliases: ["pittsburgh"], latitude: 40.4406, longitude: -79.9959 },
  { aliases: ["arlington"], latitude: 38.8816, longitude: -77.091 },
  { aliases: ["reston"], latitude: 38.9586, longitude: -77.357 },
  { aliases: ["washington dc", "washington, dc", "district of columbia", "dc"], latitude: 38.9072, longitude: -77.0369 },
  { aliases: ["london", "united kingdom", "uk"], latitude: 51.5072, longitude: -0.1276 },
  { aliases: ["warsaw", "poland"], latitude: 52.2297, longitude: 21.0122 },
];

export function parseDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function toIsoDate(value) {
  const date = value instanceof Date ? value : parseDate(value);
  return date ? date.toISOString() : null;
}

export function matchesKeyword(job, keyword, keywordScope = "title_and_description", keywordMode = "strict") {
  if (!keyword) {
    return true;
  }

  const query = normalizeText(keyword);
  if (!query) {
    return true;
  }

  const queries = expandKeywordQueries(query);
  const aliasConfigured = Array.isArray(KEYWORD_ALIASES[query]) && KEYWORD_ALIASES[query].length > 0;
  const title = normalizeText(job.title);
  const description = normalizeText(job.searchText || job.descriptionSnippet);
  const queryWords = query.split(" ").filter(Boolean);
  const searchInDescription = keywordScope === "title_and_description";
  const useLooseMatching = keywordMode === "loose";
  const titleFocusedAliasQuery = aliasConfigured && TITLE_FOCUSED_ALIAS_QUERIES.has(query);

  if (!useLooseMatching) {
    const strictQueries = [query];

    if (titleFocusedAliasQuery) {
      return strictQueries.some((candidate) => matchesCandidateInText(title, candidate));
    }

    const strictHaystacks = [title];
    if (searchInDescription) {
      strictHaystacks.push(description);
    }

    return strictHaystacks.some((haystack) => strictQueries.some((candidate) => matchesCandidateInText(haystack, candidate)));
  }

  if (titleFocusedAliasQuery) {
    return queries.some((candidate) => matchesCandidateLoosely(title, candidate));
  }

  if (queryWords.length > 1) {
    return queries.some((candidate) => {
      if (matchesCandidateLoosely(title, candidate)) {
        return true;
      }

      return searchInDescription ? matchesCandidateLoosely(description, candidate) : false;
    });
  }

  const haystack = normalizeText(
    [
      job.title,
      searchInDescription ? (job.searchText || job.descriptionSnippet) : null,
    ]
      .filter(Boolean)
      .join(" ")
  );

  return queries.some((candidate) => matchesCandidateLoosely(haystack, candidate));
}

function containsSearchPhrase(haystack, phrase) {
  if (!haystack || !phrase) {
    return false;
  }

  const compactHaystack = normalizeText(haystack);
  const compactPhrase = normalizeText(phrase);
  if (!compactHaystack || !compactPhrase) {
    return false;
  }

  return compactHaystack.includes(compactPhrase);
}

function containsWholeWord(haystack, word) {
  if (!haystack || !word) {
    return false;
  }

  const normalizedHaystack = normalizeText(haystack);
  const normalizedWord = normalizeText(word);
  if (!normalizedHaystack || !normalizedWord) {
    return false;
  }

  const escapedWord = normalizedWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escapedWord}\\b`, "i").test(normalizedHaystack);
}

function matchesCandidateInText(haystack, candidate) {
  const normalizedCandidate = normalizeText(candidate);
  if (!normalizedCandidate) {
    return false;
  }

  return normalizedCandidate.includes(" ")
    ? containsSearchPhrase(haystack, normalizedCandidate)
    : containsWholeWord(haystack, normalizedCandidate);
}

function matchesCandidateLoosely(haystack, candidate) {
  const normalizedCandidate = normalizeText(candidate);
  if (!normalizedCandidate) {
    return false;
  }

  if (matchesCandidateInText(haystack, normalizedCandidate)) {
    return true;
  }

  if (!normalizedCandidate.includes(" ")) {
    return false;
  }

  return containsOrderedWords(haystack, normalizedCandidate);
}

function containsOrderedWords(haystack, phrase) {
  if (!haystack || !phrase) {
    return false;
  }

  const haystackWords = normalizeText(haystack).split(" ").filter(Boolean);
  const phraseWords = normalizeText(phrase).split(" ").filter(Boolean);
  if (haystackWords.length === 0 || phraseWords.length === 0) {
    return false;
  }

  let phraseIndex = 0;
  for (const word of haystackWords) {
    if (word === phraseWords[phraseIndex]) {
      phraseIndex += 1;
      if (phraseIndex === phraseWords.length) {
        return true;
      }
    }
  }

  return false;
}

function expandKeywordQueries(query) {
  const aliases = KEYWORD_ALIASES[query];
  const values = Array.isArray(aliases) && aliases.length > 0 ? aliases : [query];
  return [...new Set(values.map((value) => normalizeText(value)).filter(Boolean))];
}

export function isLikelyJobPosting(job) {
  const title = normalizeText(job?.title);
  const applyUrl = String(job?.applyUrl || "").toLowerCase();
  const provider = String(job?.provider || "").toLowerCase();

  if (!title || title.length < 4) {
    return false;
  }

  const blockedExactTitles = new Set([
    "about us",
    "benefits",
    "blog",
    "careers",
    "career opportunities",
    "contact us",
    "cookie policy",
    "cookie preferences",
    "cookie settings",
    "current openings",
    "employee login",
    "eeo statement",
    "eeo statement and accommodation request",
    "events",
    "job alerts",
    "job opportunities",
    "join our talent network",
    "locations",
    "log in",
    "login",
    "open positions",
    "our culture",
    "our events",
    "preferences",
    "privacy policy",
    "physicians and providers",
    "recently viewed jobs",
    "saved jobs",
    "search jobs",
    "search our open positions",
    "nursing careers",
    "search provider careers",
    "search nursing careers",
    "sign in",
    "talent community",
    "talent network",
    "team members",
    "all careers",
    "view my profile",
    "view all jobs",
    "view chi jobs",
    "view jobs",
  ]);

  if (blockedExactTitles.has(title)) {
    return false;
  }

  const blockedTitlePatterns = [
    /\b(applicant login|employee login|forgot password)\b/i,
    /\b(benefits|blog|cookie|culture|events|faqs|locations|saved jobs|team members?)\b/i,
    /\b(eeo statement|accommodation request|physicians and providers|view my profile)\b/i,
    /\b(preferences|privacy policy|privacy choices|terms of use)\b/i,
    /\b(search|view)\b.*\b(jobs|careers)\b/i,
    /\btalent (community|network)\b/i,
  ];

  if (blockedTitlePatterns.some((pattern) => pattern.test(title))) {
    return false;
  }

  const blockedHrefFragments = [
    "/about",
    "/benefits",
    "/blog",
    "/cookie",
    "/culture",
    "/employee",
    "/eeo",
    "/events",
    "/faq",
    "/faqs",
    "/locations",
    "/log-in",
    "/login",
    "/privacy",
    "/preferences",
    "/saved-jobs",
    "/savedjobs",
    "/sign-in",
    "/signin",
    "/talent-network",
    "/talentcommunity",
    "/team-members",
    "/terms",
    "/profile",
  ];

  if (blockedHrefFragments.some((fragment) => applyUrl.includes(fragment))) {
    return false;
  }

  if (provider === "careerpage" && !hasCareerPageJobSignals(title, applyUrl)) {
    return false;
  }

  return true;
}

function hasCareerPageJobSignals(title, applyUrl) {
  const jobUrlSignals = [
    "/job/",
    "/jobs/",
    "/job-",
    "jobid=",
    "job_id=",
    "jobreqid",
    "gh_jid",
    "requisition",
    "opening",
    "/opening/",
    "/position/",
    "/positions/",
    "/posting/",
    "/postings/",
    "/opportunitydetail",
    "/vacancy/",
    "careersection",
  ];

  if (jobUrlSignals.some((signal) => applyUrl.includes(signal))) {
    return true;
  }

  return hasConcreteRoleTitle(title);
}

function hasConcreteRoleTitle(title) {
  return /\b(account(ant| executive| manager)?|administrator|analyst|architect|assistant|associate|attorney|advisor|counsel|consultant|coordinator|designer|developer|director|editor|engineer|head|intern|lead|manager|officer|partner|physician|nurse|practitioner|principal|producer|product manager|product owner|product marketer|product marketing|program manager|programmer|project manager|recruiter|representative|research(?:er| scientist)?|scientist|software|specialist|strategist|supervisor|technician|therapist|vp|vice president|writer)\b/i.test(title);
}

export function matchesRecency(job, recencyKey) {
  if (!recencyKey || !RECENCY_WINDOWS[recencyKey] || !job.postedAt) {
    return true;
  }

  return Date.now() - new Date(job.postedAt).getTime() <= RECENCY_WINDOWS[recencyKey];
}

export function inferWorkArrangement(text) {
  const value = (text || "").toLowerCase();

  if (!value) {
    return "unknown";
  }

  if (value.includes("remote")) {
    return value.includes("hybrid") ? "hybrid" : "remote";
  }

  if (value.includes("hybrid")) {
    return "hybrid";
  }

  if (value.includes("on-site") || value.includes("onsite") || value.includes("office")) {
    return "onsite";
  }

  return "unknown";
}

export function normalizeCompany(value, fallback = "Unknown company") {
  return (value || fallback).trim();
}

export function uniqueBy(items, keyFn) {
  const seen = new Set();
  const output = [];

  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(item);
  }

  return output;
}

export function normalizeWorkArrangement(value) {
  const arrangement = (value || "").toLowerCase();
  if (["remote", "hybrid", "onsite", "unknown"].includes(arrangement)) {
    return arrangement;
  }
  return inferWorkArrangement(value);
}

export function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s,.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchesLocationGroups(job, locationGroups) {
  const groups = (locationGroups || []).filter((group) => group && (group.stateCode || (group.areaNames && group.areaNames.length > 0)));

  if (groups.length === 0) {
    return true;
  }

  const haystack = normalizeLocationHaystack(job);

  return groups.some((group) => {
    const stateMatch = !group.stateCode
      || haystack.includes(normalizeText(group.stateCode))
      || haystack.includes(stateNameFromCode(group.stateCode));

    const areaNames = Array.isArray(group.areaNames) ? group.areaNames.filter(Boolean) : [];
    const areaMatch = areaNames.length === 0
      || areaNames.some((areaName) => haystack.includes(normalizeText(areaName)));

    return stateMatch && areaMatch;
  });
}

export function matchesUnitedStates(job) {
  const haystack = normalizeLocationHaystack(job);

  if (!haystack) {
    return false;
  }

  const normalizedCountry = normalizeText(job.country);
  const normalizedRegion = normalizeText(job.region);

  if (["us", "usa", "united states", "united states of america"].includes(normalizedCountry)) {
    return true;
  }

  if (normalizedRegion && stateNameFromCode(normalizedRegion.toUpperCase()) !== normalizedRegion) {
    return true;
  }

  return haystack.includes(" united states ")
    || haystack.startsWith("united states ")
    || haystack.endsWith(" united states")
    || haystack.includes(" usa ")
    || haystack.startsWith("usa ")
    || haystack.endsWith(" usa")
    || haystack.includes(" us ")
    || haystack.startsWith("us ")
    || haystack.endsWith(" us");
}

export function hasSpecifiedLocation(job) {
  const parts = [
    job.locationLabel,
    job.rawLocationText,
    job.city,
    job.region,
    job.country,
  ]
    .map((value) => normalizeText(value))
    .filter(Boolean)
    .filter((value) => value !== "unspecified");

  return parts.length > 0;
}

export function calculateJobDistanceMiles(job, originCoordinates) {
  if (!originCoordinates?.latitude || !originCoordinates?.longitude) {
    return null;
  }

  const jobCoordinates = extractJobCoordinates(job);
  if (!jobCoordinates) {
    return null;
  }

  return haversineMiles(originCoordinates.latitude, originCoordinates.longitude, jobCoordinates.latitude, jobCoordinates.longitude);
}

export function extractJobCoordinates(job) {
  const haystack = normalizeLocationHaystack(job);

  for (const location of LOCATION_ALIASES) {
    if (location.aliases.some((alias) => haystack.includes(normalizeText(alias)))) {
      return {
        latitude: location.latitude,
        longitude: location.longitude,
      };
    }
  }

  return null;
}

function normalizeLocationHaystack(job) {
  return normalizeText([
    job.locationLabel,
    job.rawLocationText,
    job.city,
    job.region,
    job.country,
  ].filter(Boolean).join(" "));
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const earthRadiusMiles = 3958.8;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusMiles * c;
}

function stateNameFromCode(code) {
  const lookup = {
    CA: "california",
    CO: "colorado",
    FL: "florida",
    GA: "georgia",
    IL: "illinois",
    MA: "massachusetts",
    NC: "north carolina",
    NJ: "new jersey",
    NY: "new york",
    OR: "oregon",
    PA: "pennsylvania",
    TX: "texas",
    VA: "virginia",
    WA: "washington",
    DC: "district of columbia",
  };

  return lookup[code] || normalizeText(code);
}
