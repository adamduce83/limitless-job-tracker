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
    // Simpro's section list and detail endpoints both return empty Name fields.
    // We no longer waste API calls fetching section details individually.
    // The cost centre filter uses a fallback: if Name is empty on ALL sections,
    // the job is included (we can't determine the cost centre, so we don't
    // exclude it).  If a future API change populates Name, filtering will
    // start working automatically.
    const sectionList = await apiGet(`/jobs/${jobId}/sections/`);
    if (!Array.isArray(sectionList) || sectionList.length === 0) return [];
    return sectionList;
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

  // ââ COST CENTRE DISCOVERY PROBES ââââââââââââââââââââââââââââââââââ
  // The API returns empty section Names. These probes try to find the
  // right endpoint or field to identify cost centres.
  console.log('=== COST CENTRE DISCOVERY PROBES ===');

  // PROBE 1: Compare full job detail for known Doors vs non-Doors job
  const KNOWN_DOORS_JOB = 124021;   // confirmed in Simpro Progress/Doors
  const KNOWN_GATE_JOB  = 124990;   // "Sliding Gate Safety Service" - NOT Doors
  try {
    const doorsDetail = await apiGet(`/jobs/${KNOWN_DOORS_JOB}`);
    const gateDetail  = await apiGet(`/jobs/${KNOWN_GATE_JOB}`);
    // Log ALL top-level keys
    console.log('PROBE1a DOORS job keys:', Object.keys(doorsDetail).join(', '));
    console.log('PROBE1b GATE  job keys:', Object.keys(gateDetail).join(', '));
    // Log key fields (excluding Description which is huge)
    const pick = (obj) => {
      const copy = {};
      for (const k of Object.keys(obj)) {
        if (k === 'Description') { copy[k] = '(omitted)'; continue; }
        copy[k] = obj[k];
      }
      return copy;
    };
    console.log('PROBE1c DOORS detail:', JSON.stringify(pick(doorsDetail)).substring(0, 1500));
    console.log('PROBE1d GATE  detail:', JSON.stringify(pick(gateDetail)).substring(0, 1500));
    // Specifically compare Name field
    console.log(`PROBE1e DOORS Name="${doorsDetail.Name}" vs GATE Name="${gateDetail.Name}"`);
        // PROBE 1f: Check CustomFields, STC, and CompletedDate specifically
        console.log('PROBE1f DOORS CustomFields:', JSON.stringify(doorsDetail.CustomFields));
        console.log('PROBE1f GATE  CustomFields:', JSON.stringify(gateDetail.CustomFields));
        console.log('PROBE1f DOORS STC:', JSON.stringify(doorsDetail.STC));
        console.log('PROBE1f GATE  STC:', JSON.stringify(gateDetail.STC));
        console.log('PROBE1f DOORS Type:', doorsDetail.Type, 'GATE Type:', gateDetail.Type);
        // Check if there's a CostCenter or Category field we missed
        const doorsKeys = Object.keys(doorsDetail);
        const interestingFields = doorsKeys.filter(k =>
                /cost|centre|center|category|division|dept|section|group|class/i.test(k)
                                                       );
        console.log('PROBE1f Fields matching cost/centre/category:', interestingFields.join(', ') || 'NONE');
  } catch (e) {
    console.log('PROBE1 ERROR:', e.message.substring(0, 300));
  }

  // PROBE 2: Individual section DETAIL (not list) - may have more fields
  try {
    const doorsSections = await apiGet(`/jobs/${KNOWN_DOORS_JOB}/sections/`);
    const gateSections  = await apiGet(`/jobs/${KNOWN_GATE_JOB}/sections/`);
    console.log('PROBE2a DOORS sections list:', JSON.stringify(doorsSections));
    console.log('PROBE2b GATE  sections list:', JSON.stringify(gateSections));
    // Fetch individual section detail
    if (doorsSections.length > 0) {
      const dsd = await apiGet(`/jobs/${KNOWN_DOORS_JOB}/sections/${doorsSections[0].ID}`);
      console.log('PROBE2c DOORS section detail:', JSON.stringify(dsd));
    }
    if (gateSections.length > 0) {
      const gsd = await apiGet(`/jobs/${KNOWN_GATE_JOB}/sections/${gateSections[0].ID}`);
      console.log('PROBE2d GATE  section detail:', JSON.stringify(gsd));
    }
  } catch (e) {
    console.log('PROBE2 ERROR:', e.message.substring(0, 300));
  }

  // PROBE 3: Try alternative cost centre API paths
  const ccPaths = [
    '/setup/costcentres/',          // British spelling
    '/setup/costcenters/',          // US spelling (tried before)
    '/setup/system/costcentres/',
    '/setup/system/costcenters/',
    '/costcenters/',
    '/costcentres/',
  ];
  for (const p of ccPaths) {
    try {
      const result = await apiGet(`${p}?pageSize=5`);
      console.log(`PROBE3 ${p} OK:`, JSON.stringify(result).substring(0, 500));
    } catch (e) {
      console.log(`PROBE3 ${p} ERROR:`, e.message.substring(0, 100));
    }
  }

  // PROBE 4: Check if sections have nested cost centre info
  try {
    const doorsSections = await apiGet(`/jobs/${KNOWN_DOORS_JOB}/sections/`);
    if (doorsSections.length > 0) {
      const secId = doorsSections[0].ID;
      // Try nested endpoints on the section
      const nestedPaths = [
        `/jobs/${KNOWN_DOORS_JOB}/sections/${secId}/costcenters/`,
        `/jobs/${KNOWN_DOORS_JOB}/sections/${secId}/costcentres/`,
        `/jobs/${KNOWN_DOORS_JOB}/sections/${secId}/?columns=Name,CostCenter,Type`,
      ];
      for (const np of nestedPaths) {
        try {
          const r = await apiGet(np);
          console.log(`PROBE4 ${np} OK:`, JSON.stringify(r).substring(0, 500));
        } catch (e) {
          console.log(`PROBE4 ${np} ERROR:`, e.message.substring(0, 100));
        }
      }
    }
  } catch (e) {
    console.log('PROBE4 ERROR:', e.message.substring(0, 200));
  }

  // PROBE 5: Check if job list supports cost centre filtering
  try {
    const filtered = await apiGet('/jobs/?pageSize=5&Stage=Progress&CostCenter=Doors');
    console.log('PROBE5a filtered count:', filtered.length, 'ids:', filtered.map(j=>j.ID));
  } catch (e) {
    console.log('PROBE5a ERROR:', e.message.substring(0, 200));
  }
  try {
    const filtered2 = await apiGet('/jobs/?pageSize=5&Stage=Progress&Section.Name=Doors');
    console.log('PROBE5b filtered count:', filtered2.length, 'ids:', filtered2.map(j=>j.ID));
  } catch (e) {
    console.log('PROBE5b ERROR:', e.message.substring(0, 200));
  }

  console.log('=== END PROBES ===');
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

      const hasDoors = sections.some(sec =>
        (sec.Name || '').toLowerCase().includes(REQUIRED_COST_CENTRE.toLowerCase())
      );

      // If ALL section names are empty (Simpro API limitation), we cannot
      // determine the cost centre â include the job rather than exclude it.
      // Once the API starts returning Names (or we find the right endpoint),
      // filtering will kick in automatically.
      const canDetermine = sections.some(sec => (sec.Name || '').trim());
      if (canDetermine && !hasDoors) {
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
