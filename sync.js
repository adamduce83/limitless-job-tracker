#!/usr/bin/env node
/**
 * Limitless Garage Doors & Gates â Simpro â Job Tracker Sync
 *
 * Pulls job data from Simpro REST API, transforms it into the tracker
 * JSON format, and updates index.html with the latest data.
 *
 * Runs nightly via GitHub Actions.
 *
 * Environment variables:
 *   SIMPRO_API_KEY  â Bearer token for Simpro API
 *   SIMPRO_BASE_URL â e.g. https://dar.simprosuite.com  (no trailing slash)
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ââ Config ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const API_KEY = process.env.SIMPRO_API_KEY;
const BASE    = (process.env.SIMPRO_BASE_URL || 'https://dar.simprosuite.com')
                  .replace(/\/+$/, '');
const API     = `${BASE}/api/v1.0/companies/0`;

// How many jobs to fetch per page (Simpro max is 250)
const PAGE_SIZE = 250;

// Simpro Status.Name  â  tracker step (1-6)
// Update this map when new statuses are added in Simpro.
const STATUS_TO_STEP = {
  'PENDING: Not Booked':               1,   // Quote Accepted
  'Pending':                            1,
  'ORDER TO BE PLACED':                 2,   // Order Placed
  'Order Placed':                       2,
  'ORDERED - In Production':            3,   // In Production
  'In Production':                      3,
  'Delivered':                          4,   // Delivered to Us
  'DELIVERED':                          4,
  'Booked - Confirmed for Site Visit':  5,   // Installation Scheduled
  'Installation Scheduled':             5,
  'COMPLETED':                          6,   // Installation Complete
  'Invoiced':                           6,
  'Complete':                           6,
};

// ââ Filters âââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// ONLY include jobs in these stages (everything else is skipped)
const ALLOWED_STAGES = ['Pending', 'Progress', 'Complete', 'Invoiced'];

// ONLY include jobs that have a section/cost centre matching this name
const REQUIRED_COST_CENTRE = 'Doors';

// Never show the business owner as an installer (safety rule)
const EXCLUDED_STAFF = ['Adam'];

// Only process the most recent N jobs by ID (keeps sync under 15 min)
// Simpro job IDs are sequential, so higher ID = newer job.
// 1000 jobs covers roughly 4-6 months of activity.
const MAX_RECENT_JOBS = 1000;

// ââ HTTP helper âââââââââââââââââââââââââââââââââââââââââââââââââââââ
function apiGet(urlPath) {
  return new Promise((resolve, reject) => {
    const url = urlPath.startsWith('http') ? urlPath : `${API}${urlPath}`;
    const opts = {
      headers: { 'Authorization': `Bearer ${API_KEY}` },
    };
    https.get(url, opts, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} on ${urlPath}: ${body.substring(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`Bad JSON from ${urlPath}: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

// Rate-limit helper: wait ms
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ââ Date helpers ââââââââââââââââââââââââââââââââââââââââââââââââââââ
function isoToAu(isoDate) {
  // "2026-06-15" â "15/06/2026"
  if (!isoDate) return null;
  const [y, m, d] = isoDate.split('-');
  if (!y || !m || !d) return isoDate;
  return `${d}/${m}/${y}`;
}

function isoToShort(isoDate) {
  // "2026-06-15" â "15/06"
  if (!isoDate) return null;
  const [, m, d] = isoDate.split('-');
  if (!m || !d) return isoDate;
  return `${d}/${m}`;
}

function addDays(isoDate, n) {
  if (!isoDate) return null;
  const dt = new Date(isoDate + 'T00:00:00');
  dt.setDate(dt.getDate() + n);
  return dt.toISOString().split('T')[0];
}

// ââ API fetchers ââââââââââââââââââââââââââââââââââââââââââââââââââââ

async function fetchAllJobs() {
  let allJobs = [];
  let page = 1;
  while (true) {
    const url = `/jobs/?pageSize=${PAGE_SIZE}&page=${page}`;
    console.log(`  Fetching jobs page ${page}...`);
    const batch = await apiGet(url);
    if (!Array.isArray(batch) || batch.length === 0) break;
    allJobs = allJobs.concat(batch);
    if (batch.length < PAGE_SIZE) break;
    page++;
    await sleep(200);
  }
  console.log(`  Total jobs in Simpro: ${allJobs.length}`);
  return allJobs;
}

async function getJobDetail(jobId) {
  return apiGet(`/jobs/${jobId}`);
}

async function getJobSections(jobId) {
  try {
    const sectionList = await apiGet(`/jobs/${jobId}/sections/`);
    if (!Array.isArray(sectionList) || sectionList.length === 0) return [];

    // The list endpoint returns sections with empty Name fields.
    // We must fetch each section's detail to get the actual Name
    // (e.g. "Doors", "Gates", etc.).
    const detailed = [];
    for (const sec of sectionList) {
      try {
        const full = await apiGet(`/jobs/${jobId}/sections/${sec.ID}`);
        detailed.push(full);
      } catch {
        detailed.push(sec);  // fallback to sparse data
      }
    }
    return detailed;
  } catch {
    return [];
  }
}

async function getJobSchedules(jobId) {
  try {
    const scheds = await apiGet(`/schedules/?jobId=${jobId}&pageSize=100`);
    return Array.isArray(scheds) ? scheds : [];
  } catch {
    return [];
  }
}

async function getJobInvoices(jobId) {
  try {
    const invs = await apiGet(`/jobs/${jobId}/invoices/`);
    return Array.isArray(invs) ? invs : [];
  } catch {
    return [];
  }
}

async function getInvoiceDetail(invId) {
  try {
    return await apiGet(`/invoices/${invId}`);
  } catch {
    return null;
  }
}

async function getSiteAddress(siteId) {
  try {
    const site = await apiGet(`/sites/${siteId}`);
    if (site && site.Address) {
      const a = site.Address;
      const parts = [a.Address, a.City, a.State, a.PostalCode].filter(Boolean);
      return parts.join(', ') || 'On file';
    }
    return site?.Name || 'On file';
  } catch {
    return 'On file';
  }
}

// ââ Resolvers âââââââââââââââââââââââââââââââââââââââââââââââââââââââ

function resolveStep(detail) {
  const statusName = detail.Status?.Name || '';
  const stageName  = detail.Stage || '';

  // Check the status-to-step map
  if (STATUS_TO_STEP[statusName] !== undefined) {
    return STATUS_TO_STEP[statusName];
  }

  // Fallback: use stage name
  const stageMap = {
    'Pending': 1,
    'Progress': 5,
    'Invoiced': 6,
    'Complete': 6,
  };
  if (stageMap[stageName] !== undefined) {
    return stageMap[stageName];
  }

  // Default
  console.warn(`  â  Unknown status "${statusName}" / stage "${stageName}" for job ${detail.ID} â defaulting to step 1`);
  return 1;
}

function resolveCustomerName(customer) {
  if (!customer) return 'Customer';
  if (customer.CompanyName) return customer.CompanyName;
  // For individuals: "Last, First" format â never expose last name alone
  const first = customer.GivenName || '';
  const last  = customer.FamilyName || '';
  if (last && first) return `${last}, ${first}`;
  return first || last || 'Customer';
}

function resolveCustomerType(customer) {
  // Company = builder ("b"), Individual = residential ("r")
  if (!customer) return 'r';
  return customer.Type === 'Company' ? 'b' : 'r';
}

function resolveInstallerAndDate(schedules, dueDate) {
  // Returns { installer, installDate } from the SAME schedule entry
  // to guarantee they always match.
  //
  // Logic:
  //   1. Look at schedules on or after the due date (these are installation,
  //      not site-visit entries).  Pick the earliest one with a real staff
  //      member who isn't the business owner.
  //   2. If nothing matches, fall back to ALL schedules sorted newest-first.
  //   3. Never return "Adam" â he is the owner, not an installer.
  if (!schedules || schedules.length === 0) {
    return { installer: null, installDate: null };
  }

  const cutoff = dueDate || '9999-99-99';

  // Post-due-date schedules, sorted earliest first
  const installSchedules = schedules
    .filter(s => s.Date && s.Date >= cutoff)
    .sort((a, b) => a.Date.localeCompare(b.Date));

  // Fallback: all schedules, sorted newest first
  const allSchedules = [...schedules]
    .filter(s => s.Date)
    .sort((a, b) => b.Date.localeCompare(a.Date));

  const pool = installSchedules.length > 0 ? installSchedules : allSchedules;

  for (const sched of pool) {
    if (sched.Staff && typeof sched.Staff === 'object') {
      const name = sched.Staff.Name;
      if (name) {
        const firstName = name.split(' ')[0];
        // Never show the business owner
        if (EXCLUDED_STAFF.some(ex => name.toLowerCase().includes(ex.toLowerCase()))) {
          continue;
        }
        return {
          installer: firstName,
          installDate: sched.Date ? isoToShort(sched.Date) : null,
        };
      }
    }
  }
  return { installer: null, installDate: null };
}

// ââ Main ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

async function main() {
  if (!API_KEY) {
    console.error('ERROR: SIMPRO_API_KEY environment variable not set');
    process.exit(1);
  }

  console.log('ð Limitless Job Tracker Sync');
  console.log(`   API: ${BASE}`);
  console.log(`   Time: ${new Date().toISOString()}`);
  console.log(`   Filters: stages=[${ALLOWED_STAGES.join(',')}]  costCentre=${REQUIRED_COST_CENTRE}`);
  console.log('');

  // 1. Fetch all job IDs
  let jobList = await fetchAllJobs();

  // 1b. Limit to most recent jobs by ID (keeps processing fast)
  // Job stubs don't include DateIssued, so we use ID as a proxy for recency.
  const beforeCount = jobList.length;
  jobList.sort((a, b) => b.ID - a.ID);           // newest first
  jobList = jobList.slice(0, MAX_RECENT_JOBS);    // keep only recent
  console.log(`  Limited to ${jobList.length} most recent jobs (from ${beforeCount} total)`);

  // 2. Process each job
  const trackerJobs = [];
  let processed = 0;
  let skippedStage = 0;
  let skippedCostCentre = 0;
  let debugCount = 0;  // count of stage-passing jobs we've debugged

  for (const stub of jobList) {
    processed++;
    if (processed % 25 === 0) {
      console.log(`  Processing ${processed}/${jobList.length}...`);
    }

    try {
      const detail = await getJobDetail(stub.ID);
      const stageName  = detail.Stage || '';

      // ââ Stage filter: ONLY allowed stages ââ
      if (!ALLOWED_STAGES.includes(stageName)) {
        skippedStage++;
        continue;
      }

      // ââ Cost centre filter: must have a "Doors" section ââ
      const sections = await getJobSections(stub.ID);

      // DEBUG: log first 5 section DETAIL responses to verify Name field
      if (debugCount < 5) {
        debugCount++;
        console.log(`  DEBUG job ${stub.ID} (stage=${stageName}) section details (${sections.length}):`, JSON.stringify(sections).substring(0, 500));
      }

      const hasDoors = sections.some(sec =>
        (sec.Name || '').toLowerCase().includes(REQUIRED_COST_CENTRE.toLowerCase())
      );
      if (!hasDoors) {
        skippedCostCentre++;
        await sleep(50);
        continue;
      }

      const step = resolveStep(detail);

      // Get schedules and invoices (only for jobs that passed both filters)
      const [schedules, invoiceStubs] = await Promise.all([
        getJobSchedules(stub.ID),
        getJobInvoices(stub.ID),
      ]);

      // Get invoice details (for paid date)
      let invoiceDate = null;
      let paidDate = null;
      if (invoiceStubs.length > 0) {
        const invDetail = await getInvoiceDetail(invoiceStubs[0].ID);
        if (invDetail) {
          invoiceDate = isoToAu(invDetail.DateIssued);
          if (invDetail.IsPaid && invDetail.DatePaid) {
            paidDate = isoToAu(invDetail.DatePaid);
          }
        }
      }

      // Get site address
      const siteId = detail.Site?.ID;
      let siteAddress = 'On file';

      // Privacy rule: step 6 (complete) jobs show "On file" instead of address
      if (step < 6 && siteId) {
        siteAddress = await getSiteAddress(siteId);
      }

      // Build the tracker job object
      const job = {
        id:   detail.ID,
        c:    resolveCustomerName(detail.Customer),
        s:    siteAddress,
        d:    isoToAu(detail.DateIssued),
        step: step,
        door: detail.Description || detail.Name || 'Garage Door',
        t:    resolveCustomerType(detail.Customer),
      };

      // Optional fields
      const dueDate = detail.DueDate;
      if (dueDate) {
        const eta = addDays(dueDate, 2);
        job.eta = isoToAu(eta);
      }

      // Installer + install date from the SAME schedule entry
      const { installer, installDate } = resolveInstallerAndDate(schedules, dueDate);
      if (installer)   job.installer   = installer;
      if (installDate) job.installDate = installDate;

      if (invoiceDate) job.invoiceDate = invoiceDate;
      if (paidDate)    job.paidDate = paidDate;

      // Deposit % â only for residential ("r") jobs
      // Simpro doesn't have a direct "deposit paid" field,
      // so we default based on step:
      //   step 6 complete = use invoice data
      //   For other steps, we leave dep undefined unless we can derive it
      if (job.t === 'r' && step >= 6) {
        // Check if paid
        if (paidDate) {
          job.dep = 100;
        } else if (invoiceDate) {
          job.dep = 50;
        } else {
          job.dep = 0;
        }
      }

      trackerJobs.push(job);

      // Rate-limit: small delay between jobs
      await sleep(50);
    } catch (err) {
      console.error(`  â Error processing job ${stub.ID}: ${err.message}`);
    }
  }

  console.log('');
  console.log(`  Skipped ${skippedStage} jobs (stage not in: ${ALLOWED_STAGES.join(', ')})`);
  console.log(`  Skipped ${skippedCostCentre} jobs (no "${REQUIRED_COST_CENTRE}" cost centre)`);
  console.log(`  â Processed ${trackerJobs.length} jobs for tracker`);

  // 3. Sort: active jobs (steps 1-5) first by date desc, then step 6 jobs
  trackerJobs.sort((a, b) => {
    if (a.step < 6 && b.step >= 6) return -1;
    if (a.step >= 6 && b.step < 6) return 1;
    // Within same group, sort by ID descending (newest first)
    return b.id - a.id;
  });

  // 4. Update index.html
  const htmlPath = path.join(__dirname, 'index.html');
  if (!fs.existsSync(htmlPath)) {
    console.error('ERROR: index.html not found at', htmlPath);
    process.exit(1);
  }

  let html = fs.readFileSync(htmlPath, 'utf8');
  const jobsJson = JSON.stringify(trackerJobs);

  // Replace the JOBS array â matches:  var JOBS = [...];
  const regex = /var JOBS\s*=\s*\[[\s\S]*?\];/;
  if (!regex.test(html)) {
    console.error('ERROR: Could not find "var JOBS = [...];" in index.html');
    process.exit(1);
  }

  html = html.replace(regex, `var JOBS = ${jobsJson};`);

  fs.writeFileSync(htmlPath, html, 'utf8');
  console.log('  â index.html updated');
  console.log(`  â ${trackerJobs.length} jobs written`);
  console.log('');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
