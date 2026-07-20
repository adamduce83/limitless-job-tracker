#!/usr/bin/env node
/**
 * Limitless Garage Doors & Gates - Simpro -> Job Tracker Sync
 *
 * Pulls job data from Simpro REST API, transforms it into the tracker
 * JSON format, and updates index.html with the latest data.
 *
 * Approach: fetches each Doors whitelist job directly by ID (no bulk scan).
 * This is fast (~244 targeted API calls) and captures ALL Doors jobs
 * regardless of age.
 *
 * Runs nightly via GitHub Actions.
 *
 * Environment variables:
 *   SIMPRO_API_KEY  - Bearer token for Simpro AP
 *   SIMPRO_BASE_URL - e.g. https://dar.simprosuite.com  (no trailing slash)
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// -- Config -------------------------------------------------------------------
const API_KEY = process.env.SIMPRO_API_KEY;
const BASE    = (process.env.SIMPRO_BASE_URL || 'https://dar.simprosuite.com')
                  .replace(/\/+$/, '');
const API     = `${BASE}/api/v1.0/companies/0`;

// Simpro Status.Name  ->  tracker step (1-6)
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

// -- Filters ------------------------------------------------------------------
// ONLY include jobs in these stages (everything else is skipped)
const ALLOWED_STAGES = ['Pending', 'Progress', 'Complete', 'Invoiced'];

// Only show approved installers on the tracker (safety rule)
const ALLOWED_INSTALLERS = ['Eddie', 'Brent', 'Brian', 'Peewee', 'Paul', 'Trent'];

// Doors cost-centre whitelist (Simpro REST API does not expose cost centres).
// Extracted from Simpro web UI Advanced Search. Update periodically.
// Each ID is fetched directly - no bulk scan needed.
const DOORS_JOB_IDS = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'doors-jobs.json'), 'utf8')
);

// -- HTTP helper --------------------------------------------------------------
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

// -- Date helpers -------------------------------------------------------------
function isoToAu(isoDate) {
  // "2026-06-15" -> "15/06/2026"
  if (!isoDate) return null;
  const [y, m, d] = isoDate.split('-');
  if (!y || !m || !d) return isoDate;
  return `${d}/${m}/${y}`;
}

// Extract door spec from Simpro job description HTML
function parseDoorInfo(descHtml) {
  if (!descHtml) return '';
  const text = descHtml
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const idx = text.indexOf('Supply & Install');
  if (idx < 0) return '';
  return text.substring(idx).trim();
}

function isoToShort(isoDate) {
  // "2026-06-15" -> "15/06"
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

// -- API fetchers -------------------------------------------------------------

async function getJobDetail(jobId) {
  return apiGet(`/jobs/${jobId}`);
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
      return parts.join(', ') || site.Name || 'On file';
    }
    return site?.Name || 'On file';
  } catch {
    return 'On file';
  }
}

// -- Resolvers ----------------------------------------------------------------

function resolveStep(detail) {
  const statusName = detail.Status?.Name || '';
  const stageName  = detail.Stage || '';

  // Determine base step from status or stage
  let step;

  // Check the status-to-step map
  if (STATUS_TO_STEP[statusName] !== undefined) {
    step = STATUS_TO_STEP[statusName];
  } else {

  // Fallback: use stage name
  const stageMap = {
    'Pending': 1,
    'Progress': 5,
    'Invoiced': 6,
    'Complete': 6,
  };
  if (stageMap[stageName] !== undefined) {
    step = stageMap[stageName];
  } else {

  // Default
  console.warn(`  ! Unknown status "${statusName}" / stage "${stageName}" for job ${detail.ID} - defaulting to step 1`);
  step = 1;
  }
  }

  // Due-date gate: use manufacturer ETA to determine delivery status
  if (detail.DueDate && step >= 3 && step <= 5) {
    const today = new Date().toISOString().split('T')[0];
    if (detail.DueDate > today) {
      step = 3; // In Production - door not delivered yet
    } else {
      step = 4; // Delivered to Us - past the ETA from manufacturer
    }
  }

  return step;
}

function resolveCustomerName(customer) {
  if (!customer) return 'Customer';
  if (customer.CompanyName) return customer.CompanyName;
  // For individuals: "Last, First" format - never expose last name alone
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
  //   3. Never return "Adam" - he is the owner, not an installer.
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
        // Only show approved installers
        if (!ALLOWED_INSTALLERS.some(inst => firstName.toLowerCase() === inst.toLowerCase())) {
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

// -- Main ---------------------------------------------------------------------

async function main() {
  if (!API_KEY) {
    console.error('ERROR: SIMPRO_API_KEY environment variable not set');
    process.exit(1);
  }

  console.log('Limitless Job Tracker Sync');
  console.log(`   API: ${BASE}`);
  console.log(`   Time: ${new Date().toISOString()}`);
  console.log(`   Whitelist: ${DOORS_JOB_IDS.length} Doors job IDs`);
  console.log(`   Stage filter: [${ALLOWED_STAGES.join(', ')}]`);
  console.log('');

  // Fetch each whitelist job directly by ID
  const trackerJobs = [];
  let processed = 0;
  let skippedStage = 0;
  let skippedError = 0;

  for (const jobId of DOORS_JOB_IDS) {
    processed++;
    if (processed % 25 === 0) {
      console.log(`  Processing ${processed}/${DOORS_JOB_IDS.length}...`);
    }

    try {
      const detail = await getJobDetail(jobId);
      const stageName  = detail.Stage || '';

      // Stage filter: ONLY allowed stages
      if (!ALLOWED_STAGES.includes(stageName)) {
        skippedStage++;
        continue;
      }

      let step = resolveStep(detail);

    // If OrderNo is "ARRIVED", door has been delivered to warehouse
    if (detail.OrderNo && detail.OrderNo.toUpperCase().includes('ARRIVED') && step < 4) {
      step = 4; // Delivered to Us
    }

      // Get schedules and invoices
      const [schedules, invoiceStubs] = await Promise.all([
        getJobSchedules(jobId),
        getJobInvoices(jobId),
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

    // If job has been invoiced, force step 6 (Installation Complete)
    if (invoiceDate) step = 6;

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
        door: parseDoorInfo(detail.Description),
        t:    resolveCustomerType(detail.Customer),
      };

      // Optional fields
      const dueDate = detail.DueDate;
      if (dueDate) {
        job.eta = isoToAu(dueDate);
      }

      job.installer = 'Peewee, Eddie, Brian';

      if (invoiceDate) job.invoiceDate = invoiceDate;
      if (paidDate)    job.paidDate = paidDate;

      // Deposit % - only for residential ("r") jobs
      if (job.t === 'r' && step >= 6) {
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
      skippedError++;
      // Don't log full error for 404s (job may have been deleted)
      if (err.message.includes('404')) {
        console.log(`  Skipped job ${jobId} (not found / deleted)`);
      } else {
        console.error(`  Error processing job ${jobId}: ${err.message}`);
      }
    }
  }

  console.log('');
  console.log(`  Whitelist IDs checked: ${DOORS_JOB_IDS.length}`);
  console.log(`  Skipped ${skippedStage} jobs (stage not in: ${ALLOWED_STAGES.join(', ')})`);
  console.log(`  Skipped ${skippedError} jobs (API errors / not found)`);
  console.log(`  >>> ${trackerJobs.length} jobs written to tracker`);

  // Sort: active jobs (steps 1-5) first by date desc, then step 6 jobs
  trackerJobs.sort((a, b) => {
    if (a.step < 6 && b.step >= 6) return -1;
    if (a.step >= 6 && b.step < 6) return 1;
    // Within same group, sort by ID descending (newest first)
    return b.id - a.id;
  });

  // Update index.html
  const htmlPath = path.join(__dirname, 'index.html');
  if (!fs.existsSync(htmlPath)) {
    console.error('ERROR: index.html not found at', htmlPath);
    process.exit(1);
  }

  let html = fs.readFileSync(htmlPath, 'utf8');
  const jobsJson = JSON.stringify(trackerJobs);

  // Replace the JOBS array - matches:  var JOBS = [...];
  const regex = /var JOBS\s*=\s*\[[\s\S]*?\];/;
  if (!regex.test(html)) {
    console.error('ERROR: Could not find "var JOBS = [...];" in index.html');
    process.exit(1);
  }

  html = html.replace(regex, `var JOBS = ${jobsJson};`);

  fs.writeFileSync(htmlPath, html, 'utf8');
  console.log('  index.html updated');

  // Also write doors-data.json for the unified /track/ page
  const dataPath = path.join(__dirname, 'doors-data.json');
  fs.writeFileSync(dataPath, JSON.stringify({
    lastUpdated: new Date().toISOString(),
    totalJobs: trackerJobs.length,
    jobs: trackerJobs
  }, null, 2), 'utf8');
  console.log('  doors-data.json updated');
  console.log(`  ${trackerJobs.length} jobs written`);
  console.log('');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
