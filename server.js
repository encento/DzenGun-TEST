const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3000);
const INDEX = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
let cache = { at: 0, jobs: [], sources: [] };

function clean(value, max = 6000) {
  return String(value ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
function toIso(value) {
  if (!value) return null;
  const d = typeof value === 'number' ? new Date(value * 1000) : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function salaryText(min, max, currency = 'USD') {
  const a = Number(min || 0), b = Number(max || 0), c = String(currency || 'USD').toUpperCase();
  if (!a && !b) return '';
  if (a && b && a !== b) return `${c} ${a.toLocaleString()}–${b.toLocaleString()}`;
  return `${c} ${(a || b).toLocaleString()}`;
}
async function fetchJson(url, headers = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(url, { headers, signal: ctl.signal });
    if (!r.ok) throw new Error(`${new URL(url).hostname} ${r.status}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}
async function loadJobs(force = false) {
  if (!force && cache.jobs.length && Date.now() - cache.at < 5 * 60 * 1000) return cache;
  const results = await Promise.allSettled([
    fetchJson('https://jobicy.com/api/v2/remote-jobs?count=100', { 'user-agent': 'JobScout/0.1' }).then(data => ({
      source: 'Jobicy',
      jobs: (data.jobs || []).map(j => ({
        source: 'Jobicy', source_job_id: String(j.id || j.jobSlug || j.url || ''),
        url: String(j.url || 'https://jobicy.com'), title: clean(j.jobTitle || j.title, 240),
        company: clean(j.companyName || j.company, 160), description: clean(j.jobExcerpt || j.jobDescription || j.description),
        location: clean(j.jobGeo || j.location || 'Remote', 160), job_type: clean(j.jobType || j.type || 'Remote', 80),
        salary_text: j.annualSalaryMin || j.annualSalaryMax ? salaryText(j.annualSalaryMin, j.annualSalaryMax, j.salaryCurrency) : clean(j.salary || '', 120),
        budget_min: Number(j.annualSalaryMin || 0) || null, budget_max: Number(j.annualSalaryMax || 0) || null,
        currency: clean(j.salaryCurrency || '', 12) || null,
        skills: Array.isArray(j.jobIndustry) ? j.jobIndustry.map(x => clean(x, 80)) : [clean(j.jobIndustry || '', 80)].filter(Boolean),
        source_published_at: toIso(j.pubDate || j.date)
      })).filter(j => j.title && j.url && j.source_job_id)
    })),
    fetchJson('https://remoteok.com/api', { 'user-agent': 'JobScout/0.1 (job aggregator beta; links to originals)', accept: 'application/json' }).then(data => ({
      source: 'Remote OK',
      jobs: (Array.isArray(data) ? data : []).filter(j => j && (j.id || j.slug) && j.position).slice(0, 120).map(j => ({
        source: 'Remote OK', source_job_id: String(j.id || j.slug),
        url: String(j.url || (j.slug ? `https://remoteok.com/remote-jobs/${j.slug}` : 'https://remoteok.com')),
        title: clean(j.position || j.title, 240), company: clean(j.company || '', 160), description: clean(j.description),
        location: clean(j.location || 'Remote', 160), job_type: 'Remote', salary_text: salaryText(j.salary_min, j.salary_max, 'USD'),
        budget_min: Number(j.salary_min || 0) || null, budget_max: Number(j.salary_max || 0) || null, currency: j.salary_min || j.salary_max ? 'USD' : null,
        skills: Array.isArray(j.tags) ? j.tags.slice(0, 20).map(x => clean(x, 80)) : [], source_published_at: toIso(j.epoch || j.date)
      })).filter(j => j.title && j.url)
    }))
  ]);
  const jobs = [], sources = [];
  for (const r of results) {
    if (r.status === 'fulfilled') { jobs.push(...r.value.jobs); sources.push({ source: r.value.source, count: r.value.jobs.length, ok: true }); }
    else sources.push({ source: 'unknown', count: 0, ok: false, error: String(r.reason?.message || r.reason) });
  }
  const seen = new Set();
  const deduped = jobs.filter(j => { const k = `${j.source}:${j.source_job_id}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a,b) => new Date(b.source_published_at || 0) - new Date(a.source_published_at || 0));
  if (deduped.length) cache = { at: Date.now(), jobs: deduped, sources };
  else if (!cache.jobs.length) cache = { at: Date.now(), jobs: [], sources };
  return cache;
}
function send(res, status, body, type='application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (u.pathname === '/health') return send(res, 200, JSON.stringify({ ok: true, service: 'JobScout', now: new Date().toISOString() }));
    if (u.pathname === '/api/jobs') {
      const data = await loadJobs(u.searchParams.get('refresh') === '1');
      return send(res, 200, JSON.stringify(data));
    }
    if (u.pathname === '/favicon.ico') return send(res, 204, '');
    return send(res, 200, INDEX, 'text/html; charset=utf-8');
  } catch (e) {
    return send(res, 500, JSON.stringify({ error: e.message || 'Internal error' }));
  }
});
server.listen(PORT, '0.0.0.0', () => console.log(`JobScout listening on :${PORT}`));
