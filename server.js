const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
require('dotenv').config();
 
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
 
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.SKELLO_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
 
let jwtToken = null;
let jwtExpiry = 0;
 
// ─── AUTH SKELLO ────────────────────────────────────────────────────────────
async function getJWT() {
  if (jwtToken && Date.now() < jwtExpiry) return jwtToken;
  const res = await fetch('https://auth.skello.io/v1/login', {
    method: 'POST',
    headers: { 'X-Api-Key': API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: '{}'
  });
  const text = await res.text();
  console.log('Login response:', res.status, text.slice(0, 200));
  if (!res.ok) throw new Error('Login failed: ' + res.status);
  const data = JSON.parse(text);
  jwtToken = data.token || data.jwt || data.access_token;
  jwtExpiry = Date.now() + 14 * 60 * 1000;
  return jwtToken;
}
 
// ─── FETCH SKELLO KPIS ───────────────────────────────────────────────────────
async function fetchSkelloKpis(date) {
  const jwt = await getJWT();
  const url = new URL('https://api.skello.io/public/v1/kpis');
  if (date) url.searchParams.set('date', date);
  const r = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${jwt}`, 'Accept': 'application/json' }
  });
  const text = await r.text();
  console.log('KPIs:', r.status, text.slice(0, 400));
  if (!r.ok) throw new Error('KPIs failed: ' + r.status);
  return JSON.parse(text);
}
 
// ─── SUPABASE SAVE ───────────────────────────────────────────────────────────
async function saveToSupabase(mois, kpisJson) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.log('Supabase non configuré, skip sauvegarde');
    return;
  }
 
  const parseHours = (val) => {
    if (!val) return 0;
    if (typeof val === 'number') return val;
    if (typeof val === 'object') return Object.values(val).reduce((s, v) => s + parseFloat(v || 0), 0);
    return parseFloat(val) || 0;
  };
 
  // Convertir l'objet Skello (ignorer champ 'status')
  const rows = Object.entries(kpisJson)
    .filter(([name, val]) => name !== 'status' && typeof val === 'object' && (val.real || val.predicted))
    .map(([name, val]) => {
    const real = val.real || {};
    const predicted = val.predicted || {};
    return {
      mois,
      parc: name,
      ms_real: parseFloat(real.salay_mass || real.salary_mass || 0),
      ms_predicted: parseFloat(predicted.salay_mass || predicted.salary_mass || 0),
      heures_real: parseFloat(real.worked_hours || 0),
      ca_real: parseFloat(real.revenue || 0),
      ca_predicted: parseFloat(predicted.revenue || 0),
      heures_sup: parseHours(real.over_hours),
      heures_comp: parseHours(real.complementary_hours),
    };
  });
 
  // Upsert dans Supabase (insert ou update si déjà existant)
  const res = await fetch(`${SUPABASE_URL}/rest/v1/kpis`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': 'resolution=merge-duplicates'
    },
    body: JSON.stringify(rows)
  });
 
  if (res.ok) {
    console.log(`✅ Supabase: ${rows.length} parcs sauvegardés pour ${mois}`);
  } else {
    const err = await res.text();
    console.error('❌ Supabase error:', res.status, err);
  }
}
 
// ─── CRON JOB — 1er de chaque mois à minuit ─────────────────────────────────
function startCron() {
  const checkAndRun = async () => {
    const now = new Date();
    if (now.getDate() === 1 && now.getHours() === 0 && now.getMinutes() < 5) {
      // Calculer le mois précédent
      const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const mois = prevMonth.toISOString().slice(0, 7) + '-01';
      console.log(`🕛 Cron: sauvegarde automatique de ${mois}`);
      try {
        const data = await fetchSkelloKpis(mois);
        await saveToSupabase(mois, data);
        console.log(`✅ Cron terminé pour ${mois}`);
      } catch (e) {
        console.error('❌ Cron error:', e.message);
      }
    }
  };
  // Vérifie toutes les 5 minutes
  setInterval(checkAndRun, 5 * 60 * 1000);
  console.log('⏰ Cron job démarré (vérification toutes les 5 min)');
}
 
// ─── ROUTES ──────────────────────────────────────────────────────────────────
 
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
 
// KPIs live depuis Skello + sauvegarde auto
app.get('/api/kpis', async (req, res) => {
  try {
    const { date } = req.query;
    const data = await fetchSkelloKpis(date);
 
    // Sauvegarde automatique si date fournie (fin de mois)
    if (date) {
      const mois = date.slice(0, 7) + '-01';
      saveToSupabase(mois, data).catch(e => console.error('Save error:', e.message));
    }
 
    res.json(data);
  } catch (e) {
    console.error('Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
 
// Forcer la sauvegarde d'un mois spécifique
app.post('/api/save/:mois', async (req, res) => {
  try {
    const { mois } = req.params; // format: 2026-03
    const date = mois + '-01';
    console.log(`📥 Sauvegarde forcée de ${date}`);
    const data = await fetchSkelloKpis(date);
    await saveToSupabase(date, data);
    res.json({ ok: true, mois, parcs: Object.keys(data).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
 
// Historique depuis Supabase
app.get('/api/history', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(503).json({ error: 'Supabase non configuré' });
  }
  try {
    const { parc, limit = 13 } = req.query;
    let url = `${SUPABASE_URL}/rest/v1/kpis?select=*&order=mois.desc&limit=${limit}`;
    if (parc) url += `&parc=eq.${encodeURIComponent(parc)}`;
 
    const r = await fetch(url, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      }
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
 
// N-1 : données du même mois l'année dernière
app.get('/api/n1', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.json([]);
  }
  try {
    const { date } = req.query; // format: 2026-04-01
    if (!date) return res.status(400).json({ error: 'date requis' });
 
    const n1Date = new Date(date);
    n1Date.setFullYear(n1Date.getFullYear() - 1);
    const n1 = n1Date.toISOString().slice(0, 10);
 
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/kpis?select=*&mois=eq.${n1}`,
      {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        }
      }
    );
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
 
app.use((req, res) => res.status(404).json({ error: 'Route introuvable' }));
 
app.listen(PORT, () => {
  console.log('✅ Proxy démarré sur port ' + PORT);
  startCron();
});
 
