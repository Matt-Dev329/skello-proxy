const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Sécurité ─────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());

// CORS : autoriser uniquement votre frontend
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',');
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('Origine non autorisée : ' + origin));
  },
  methods: ['GET'],
  credentials: true,
}));

// Rate limiting : 100 requêtes / 15 min par IP
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Trop de requêtes, réessayez dans 15 minutes.' },
}));

// ─── Config Skello ─────────────────────────────────────────────────────────────
const SKELLO_BASE = 'https://api.skello.io/v1';
const SKELLO_TOKEN = process.env.SKELLO_TOKEN; // jamais dans le code !

if (!SKELLO_TOKEN) {
  console.error('❌  SKELLO_TOKEN manquant dans .env');
  process.exit(1);
}

// ─── Helper fetch Skello ───────────────────────────────────────────────────────
async function skelloGet(path, queryParams = {}) {
  const url = new URL(SKELLO_BASE + path);
  Object.entries(queryParams).forEach(([k, v]) => v !== undefined && url.searchParams.set(k, v));

  const res = await fetch(url.toString(), {
    headers: {
      'X-API-Key': SKELLO_TOKEN,
      'Content-Type': 'application/json',
    },
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  if (!res.ok) throw { status: res.status, body: json };
  return json;
}

// ─── Cache simple en mémoire (TTL 5 min) ──────────────────────────────────────
const cache = new Map();
function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) return Promise.resolve(hit.data);
  return fn().then(data => { cache.set(key, { data, ts: Date.now() }); return data; });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Santé
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// Toutes les organisations (parcs)
app.get('/api/organisations', (req, res) =>
  cached('organisations', 5 * 60 * 1000, () => skelloGet('/organisations'))
    .then(data => res.json(data))
    .catch(err => handleError(res, err))
);

// Employés (filtrables par organisation)
app.get('/api/employees', (req, res) => {
  const { organisation_id, page = 1, per_page = 100 } = req.query;
  const cacheKey = `employees:${organisation_id || 'all'}:${page}`;
  return cached(cacheKey, 5 * 60 * 1000, () =>
    skelloGet('/employees', { organisation_id, page, per_page })
  )
    .then(data => res.json(data))
    .catch(err => handleError(res, err));
});

// Absences
app.get('/api/absences', (req, res) => {
  const { organisation_id, start_date, end_date, page = 1 } = req.query;
  const cacheKey = `absences:${organisation_id || 'all'}:${start_date}:${end_date}:${page}`;
  return cached(cacheKey, 5 * 60 * 1000, () =>
    skelloGet('/absences', { organisation_id, start_date, end_date, page })
  )
    .then(data => res.json(data))
    .catch(err => handleError(res, err));
});

// Plannings / shifts
app.get('/api/shifts', (req, res) => {
  const { organisation_id, start_date, end_date, page = 1 } = req.query;
  const cacheKey = `shifts:${organisation_id || 'all'}:${start_date}:${end_date}:${page}`;
  return cached(cacheKey, 5 * 60 * 1000, () =>
    skelloGet('/shifts', { organisation_id, start_date, end_date, page })
  )
    .then(data => res.json(data))
    .catch(err => handleError(res, err));
});

// Rapport analytique (masse salariale, coûts)
app.get('/api/analytics', (req, res) => {
  const { organisation_id, start_date, end_date } = req.query;
  const cacheKey = `analytics:${organisation_id || 'all'}:${start_date}:${end_date}`;
  return cached(cacheKey, 5 * 60 * 1000, () =>
    skelloGet('/analytics', { organisation_id, start_date, end_date })
  )
    .then(data => res.json(data))
    .catch(err => handleError(res, err));
});

// KPIs agrégés multi-parcs (endpoint composite)
app.get('/api/kpis', async (req, res) => {
  const { start_date, end_date } = req.query;
  try {
    const [orgs, employees, absences] = await Promise.all([
      cached('organisations', 5 * 60 * 1000, () => skelloGet('/organisations')),
      cached(`employees:all`, 5 * 60 * 1000, () => skelloGet('/employees', { per_page: 200 })),
      cached(`absences:all:${start_date}:${end_date}`, 5 * 60 * 1000, () =>
        skelloGet('/absences', { start_date, end_date })
      ),
    ]);

    const orgList = orgs.organisations || orgs.data || [];
    const empList = employees.employees || employees.data || [];
    const absList = absences.absences || absences.data || [];

    // Agrégation par organisation
    const summary = orgList.map(org => {
      const orgEmps = empList.filter(e =>
        (e.organisation_id || e.attributes?.organisation_id) === org.id
      );
      const orgAbs = absList.filter(a =>
        (a.organisation_id || a.attributes?.organisation_id) === org.id
      );
      return {
        id: org.id,
        name: org.name || org.attributes?.name,
        effectif: orgEmps.length,
        absences_jours: orgAbs.reduce((sum, a) => sum + (a.duration_in_days || a.attributes?.duration_in_days || 0), 0),
        taux_absenteisme: orgEmps.length
          ? (orgAbs.reduce((s, a) => s + (a.duration_in_days || 0), 0) / (orgEmps.length * 20) * 100).toFixed(1)
          : 0,
      };
    });

    res.json({
      period: { start_date, end_date },
      total_effectif: empList.length,
      total_organisations: orgList.length,
      organisations: summary,
    });
  } catch (err) {
    handleError(res, err);
  }
});

// ─── Gestion d'erreurs ────────────────────────────────────────────────────────
function handleError(res, err) {
  console.error('Skello API error:', err);
  if (err.status) {
    return res.status(err.status).json({ error: 'Erreur Skello', details: err.body });
  }
  res.status(500).json({ error: 'Erreur serveur', message: err.message });
}

app.use((req, res) => res.status(404).json({ error: 'Route introuvable' }));

// ─── Démarrage ────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅  Proxy Skello démarré sur http://localhost:${PORT}`);
  console.log(`   Token configuré : ${SKELLO_TOKEN.slice(0, 6)}...`);
});

module.exports = app;
