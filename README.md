# ATS Job Aggregator

A lightweight local web app that searches across configured ATS-backed career pages and normalizes results into one filterable list. It excludes aggregator sites like LinkedIn, Indeed, and Glassdoor to avoid ads, reposted, and ghost listings from for-profit platforms that treat users as the product.

## What it does

- Searches multiple public ATS job feeds in one request
- Filters by job title or keyword text
- Limits results to jobs posted within `24h`, `3d`, `7d`, `14d`, or `30d`
- Lets users pick work arrangements with checkboxes for `remote`, `hybrid`, and `onsite`
- Lets users narrow hybrid and onsite roles by `state` and `city or area`
- Lets users exclude companies with checkbox filters, including starter options such as `Amazon`, `Microsoft`, `Expedia`, `Meta`, and `Google`
- Lets users choose which configured ATS sources to include in a given search
- Returns partial results when some job boards are slow instead of leaving the UI stuck in `Searching`

## Supported ATS adapters

This project now supports these ATS families:

- `Greenhouse` via public board API
- `Lever` via public postings API
- `Ashby` via public job board API
- `SmartRecruiters` via public postings API
- `Workable` via public jobs endpoint
- `Recruitee` via public offers API
- `Jobvite` via hosted careers page parsing
- `ApplicantPro` via hosted careers page parsing
- `ApplyToJob / JazzHR` via hosted careers page parsing
- `Taleo` via RSS feed or hosted careers page parsing
- `UltiPro / UKG` via hosted careers page parsing
- `iCIMS` via authenticated search endpoint

Important: there is no universal public API that lists every job from every ATS. In practice, this tool searches the company boards you configure in `config/sources.json`.

## Configure sources

Edit `config/sources.json` and add the companies you want to search.

Example entries:

```json
{
  "key": "openai-ashby",
  "company": "OpenAI",
  "provider": "ashby",
  "organization": "openai"
}
```

```json
{
  "key": "stripe-greenhouse",
  "company": "Stripe",
  "provider": "greenhouse",
  "boardToken": "stripe"
}
```

```json
{
  "key": "actionet-jobvite",
  "company": "ActioNet",
  "provider": "jobvite",
  "site": "actionet"
}
```

Provider-specific fields:

- `greenhouse`: `boardToken`
- `lever`: `site`
- `ashby`: `organization`
- `smartrecruiters`: `companyIdentifier`
- `workable`: `subdomain`
- `recruitee`: `subdomain`
- `jobvite`: `site` or `careersUrl`
- `applicantpro`: `careersUrl`
- `applytojob`: `careersUrl`
- `taleo`: `rssUrl` or `careersUrl`
- `ultipro`: `careersUrl`
- `icims`: `customerId`, `portalId` or `portalName`, `username`, `password`

## Notes on coverage

- `Recruitee`, `Greenhouse`, `Lever`, `Ashby`, `SmartRecruiters`, and many `Workable` boards are the cleanest integrations because they expose stable public job data.
- `Jobvite`, `ApplicantPro`, `ApplyToJob`, `UltiPro`, and many `Taleo` implementations are often company-hosted pages rather than a universal anonymous API, so this project reads their public career pages or feeds instead.
- `iCIMS` has an official API, but it requires customer-specific authentication.

## Configure locations

Edit `config/locations.json` to expand the available state and area dropdown options.

## Run locally

If PowerShell blocks `npm`, use `npm.cmd` instead.

```powershell
npm.cmd start
```

Then open [http://localhost:3000](http://localhost:3000).

## Notes

- Slow sources now time out so the app can still show partial results.
- The `Distance` control is currently disabled while the search path is stabilized. State and area matching is active now.
- Location matching is text-based for speed and consistency.

## Suggested next improvements

- Reintroduce a precise distance filter with a cached geolocation layer
- Add persistence for saved searches and excluded companies
- Import company source lists from CSV
- Add adapter autodetection from a pasted careers URL
- Cache ATS responses on disk
- Export results to CSV
