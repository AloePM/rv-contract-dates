// index.js — Aloe PM Contract Date Updater
// Cloud Run Job: runs once, updates dateContractBegins in Rentvine, exits.
// No interactive prompts — runs headless. Skips any property that already
// has dateContractBegins set. Logs all results to stdout (visible in Cloud Run logs).

const https = require('https');
const CSV_DATA = require('./csv-data');

// ── Rentvine credentials ────────────────────────────────────────────────────
const RV_AUTH = process.env.RV_AUTH || 'Basic ODhkMjJjOGM5NmJlNDYyMWJjMGI3YWRlZGIzZWY3NmQ6MDUzMjFmOGNlMDkwNGVlNGFiNGQ3YzJhODMyYjZkMmU=';
const RV_BASE = 'https://aloepm.rentvine.com/api/manager';
const RV_ACCT = 'aloepm';

// ── Config ──────────────────────────────────────────────────────────────────
// DRY_RUN=true  → show what would be updated, don't write anything
// DRY_RUN=false → actually write to Rentvine (default)
const DRY_RUN = process.env.DRY_RUN === 'true';

// ── Address normalizer ───────────────────────────────────────────────────────
function normalize(addr) {
  if (!addr) return '';
  return addr.toUpperCase()
    .replace(/\bNORTH\b/g, 'N').replace(/\bSOUTH\b/g, 'S')
    .replace(/\bEAST\b/g,  'E').replace(/\bWEST\b/g,  'W')
    .replace(/\bAVENUE\b/g, 'AVE').replace(/\bAVE\./g, 'AVE')
    .replace(/\bSTREET\b/g, 'ST').replace(/\bDRIVE\b/g, 'DR')
    .replace(/\bLANE\b/g,   'LN').replace(/\bROAD\b/g,  'RD')
    .replace(/\bBOULEVARD\b/g, 'BLVD').replace(/\bCOURT\b/g, 'CT')
    .replace(/\bPLACE\b/g, 'PL').replace(/\bTRAIL\b/g, 'TRL')
    .replace(/\bWAY\b/g, 'WAY').replace(/\bCIRCLE\b/g, 'CIR')
    .replace(/\s+/g, ' ').trim();
}

// Known AZ cities sorted longest-first so multi-word cities match before single-word
const AZ_CITIES = [
  'LITCHFIELD PARK','CAVE CREEK','SAN TAN VALLEY','QUEEN CREEK','APACHE JUNCTION',
  'ARIZONA CITY','SUN CITY WEST','SUN CITY','SUN LAKES','EL MIRAGE','NEW RIVER',
  'FOUNTAIN HILLS','CASA GRANDE','MARICOPA','SCOTTSDALE','CHANDLER','GILBERT',
  'MESA','PHOENIX','GLENDALE','PEORIA','SURPRISE','GOODYEAR','TEMPE','AVONDALE',
  'BUCKEYE','YOUNGTOWN','LAVEEN','SEDONA','TUCSON','TOLLESON'
].sort((a,b) => b.length - a.length);

// Strip city, state, zip from end of address
// "18840 North Leland Road Maricopa, AZ 85138" → "18840 North Leland Road"
function stripCityStateZip(addr) {
  let result = addr.replace(/,\s*AZ\s+\d{5}(-\d{4})?\s*$/i, '').trim().replace(/,\s*$/, '').trim();
  const upper = result.toUpperCase();
  for (const city of AZ_CITIES) {
    if (upper.endsWith(city)) {
      result = result.slice(0, result.length - city.length).trim().replace(/,\s*$/, '').trim();
      break;
    }
  }
  return result;
}

function streetNum(addr) {
  const m = addr.match(/^(\d+)/);
  return m ? m[1] : '';
}

// ── Build CSV lookup ─────────────────────────────────────────────────────────
// Key on normalized STREET ONLY (no city/state/zip)
const exactMap = new Map();
const numIndex  = new Map(); // streetNum → [{norm, date}]

CSV_DATA.forEach(row => {
  const streetOnly = stripCityStateZip(row.full_address);
  const norm = normalize(streetOnly);
  exactMap.set(norm, row.date);
  const num = streetNum(norm);
  if (num) {
    if (!numIndex.has(num)) numIndex.set(num, []);
    numIndex.get(num).push({ norm, date: row.date });
  }
});

function findDate(rvAddress) {
  // Rentvine returns street only (no city/state) — normalize directly
  const norm = normalize(rvAddress);

  // Exact match
  if (exactMap.has(norm)) return { date: exactMap.get(norm), matchType: 'exact' };

  // Also try stripping city/state in case Rentvine includes it sometimes
  const stripped = normalize(stripCityStateZip(rvAddress));
  if (exactMap.has(stripped)) return { date: exactMap.get(stripped), matchType: 'exact-stripped' };

  // Fuzzy: same street number + first 30 chars of street name match
  const num = streetNum(norm);
  const candidates = numIndex.get(num) || [];
  const rvStreet = norm.replace(/^\d+\s*/, '').slice(0, 30);
  for (const c of candidates) {
    const csvStreet = c.norm.replace(/^\d+\s*/, '').slice(0, 30);
    if (rvStreet === csvStreet) return { date: c.date, matchType: 'fuzzy' };
  }

  // Fuzzy fallback: street number + first 15 chars (catches abbreviation differences)
  const rvStreetShort = norm.replace(/^\d+\s*/, '').slice(0, 15);
  for (const c of candidates) {
    const csvStreetShort = c.norm.replace(/^\d+\s*/, '').slice(0, 15);
    if (rvStreetShort === csvStreetShort) return { date: c.date, matchType: 'fuzzy-short' };
  }

  return null;
}

// ── Rentvine API helpers ─────────────────────────────────────────────────────
function rv(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(RV_BASE + path);
    const opts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': RV_AUTH,
        'X-Rentvine-Account': RV_ACCT,
        'Content-Type': 'application/json',
      },
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function fetchAllPages(path, params = {}) {
  let all = [], page = 1;
  while (true) {
    const qs = new URLSearchParams({ ...params, pageSize: 200, page }).toString();
    const batch = await rv('GET', `${path}?${qs}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all = all.concat(batch);
    if (batch.length < 200) break;
    page++;
  }
  return all;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Aloe PM — Rentvine Contract Date Updater ===');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE (will write to Rentvine)'}`);
  console.log(`CSV entries loaded: ${CSV_DATA.length}`);
  console.log('');

  console.log('Fetching properties from Rentvine (active + inactive)...');
  const [activeRaw, inactiveRaw] = await Promise.all([
    fetchAllPages('/properties/export', { isActive: true }),
    fetchAllPages('/properties/export', { isActive: false }),
  ]);
  const allRaw = [...activeRaw, ...inactiveRaw];
  console.log(`  Fetched ${allRaw.length} total properties\n`);

  const toUpdate   = [];
  const alreadySet = [];
  const noMatch    = [];

  for (const item of allRaw) {
    const p = item.property || item;
    const propertyID = p.propertyID;
    const rvAddress  = p.address || '';
    const existing   = p.dateContractBegins;

    if (existing) {
      alreadySet.push({ propertyID, address: rvAddress, existing });
      continue;
    }

    const found = findDate(rvAddress);
    if (!found) {
      noMatch.push({ propertyID, address: rvAddress });
      continue;
    }

    toUpdate.push({ propertyID, address: rvAddress, date: found.date, matchType: found.matchType });
  }

  console.log('=== SUMMARY ===');
  console.log(`  Already have dateContractBegins: ${alreadySet.length}`);
  console.log(`  Will be updated:                 ${toUpdate.length}`);
  console.log(`  No CSV match found:              ${noMatch.length}`);
  console.log('');

  if (noMatch.length > 0) {
    console.log('Properties with NO CSV match (skipped):');
    noMatch.forEach(r => console.log(`  [${r.propertyID}] ${r.address}`));
    console.log('');
  }

  if (toUpdate.length === 0) {
    console.log('Nothing to update. All properties already have dateContractBegins set.');
    process.exit(0);
  }

  console.log(`Properties to update (${toUpdate.length} total):`);
  toUpdate.forEach((r, i) => {
    console.log(`  ${String(i+1).padStart(4)}. [${r.propertyID}] ${r.matchType.padEnd(6)} ${r.date}  ${r.address}`);
  });
  console.log('');

  if (DRY_RUN) {
    console.log('DRY RUN — no changes written. Set DRY_RUN=false to execute.');
    process.exit(0);
  }

  console.log(`Writing dateContractBegins for ${toUpdate.length} properties...`);
  let success = 0, failed = 0;
  const errors = [];

  for (let i = 0; i < toUpdate.length; i++) {
    const r = toUpdate[i];
    try {
      await rv('PUT', `/properties/${r.propertyID}`, {
        dateContractBegins: r.date,
      });
      success++;
      // Progress log every 50 or at the end
      if ((i + 1) % 50 === 0 || i === toUpdate.length - 1) {
        console.log(`  Progress: ${i + 1}/${toUpdate.length} — ${success} updated, ${failed} failed`);
      }
      await sleep(120); // ~8 req/sec, stays well under Rentvine rate limits
    } catch (e) {
      failed++;
      errors.push({ propertyID: r.propertyID, address: r.address, error: e.message });
      console.error(`  FAILED [${r.propertyID}] ${r.address}: ${e.message}`);
    }
  }

  console.log('');
  console.log('=== RESULTS ===');
  console.log(`  ✓ Updated:  ${success}`);
  console.log(`  ✗ Failed:   ${failed}`);

  if (errors.length > 0) {
    console.log('\nFailed properties:');
    errors.forEach(e => console.log(`  [${e.propertyID}] ${e.address} — ${e.error}`));
  }

  console.log('\nDone. Pull a fresh Rentvine Units export to verify.');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
