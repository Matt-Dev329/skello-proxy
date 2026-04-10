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

// ─── AUTH SKELLO ──────────────────────────────────────────────────────────────
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

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const parseHours = (val) => {
  if (!val) return 0;
  if (typeof val === 'number') return val;
  if (typeof val === 'object') return Object.values(val).reduce((s, v) => s + parseFloat(v || 0), 0);
  return parseFloat(val) || 0;
};

// Durée en heures entre deux datetime ISO
function durationHours(start, end) {
  if (!start || !end) return 0;
  const diff = (new Date(end) - new Date(start)) / (1000 * 60 * 60);
  return diff > 0 ? diff : 0;
}

// Upsert générique Supabase
async function sbUpsert(table, rows) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  if (!rows.length) { console.log(`⚠️  ${table}: aucune ligne`); return; }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
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
    console.log(`✅ ${table}: ${rows.length} lignes upsertées`);
  } else {
    const err = await res.text();
    console.error(`❌ ${table} error:`, res.status, err);
  }
}

// Fetch Skello avec pagination automatique
async function skelloFetch(path, params = {}) {
  const jwt = await getJWT();
  const url = new URL(`https://api.skello.io/public/v1/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${jwt}`, 'Accept': 'application/json' }
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path} failed: ${r.status} — ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// Récupérer toutes les organisations
async function getOrganisations() {
  const data = await skelloFetch('organisations');
  const orgs = Array.isArray(data) ? data : (data.organisations || data.data || []);
  console.log(`🏢 ${orgs.length} organisations:`, orgs.map(o => (o.name || o.label || o.id)));
  return orgs;
}

// ─── FETCH SKELLO KPIs (masse salariale, CA, heures déclarées) ─────────────────
async function fetchSkelloKpis(date) {
  const jwt = await getJWT();
  const url = new URL('https://api.skello.io/public/v1/kpis');
  if (date) url.searchParams.set('date', date);
  const r = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${jwt}`, 'Accept': 'application/json' }
  });
  const text = await r.text();
  console.log('KPIs raw:', r.status, text.slice(0, 500));
  if (!r.ok) throw new Error('KPIs failed: ' + r.status);
  return JSON.parse(text);
}

// ─── FETCH HEURES RÉELLES depuis /shifts (planning réel) ──────────────────────
// Skello /shifts retourne les créneaux du planning.
// On calcule les heures réelles en sommant les durées de chaque shift.
async function fetchHeuresShifts(orgId, startDate, endDate) {
  try {
    const data = await skelloFetch('shifts', {
      organisation_id: orgId,
      start_date: startDate,
      end_date: endDate,
      per_page: 500
    });

    const shifts = Array.isArray(data) ? data : (data.shifts || data.data || []);
    console.log(`  ⏱️  ${shifts.length} shifts pour org ${orgId}`);

    let heures_real = 0;
    let heures_sup = 0;
    let heures_comp = 0;

    for (const shift of shifts) {
      // Différentes structures possibles selon version API Skello
      let duree = 0;

      if (shift.duration) {
        // durée en minutes ou secondes ou heures
        duree = parseFloat(shift.duration);
        // Skello retourne souvent en minutes
        if (duree > 1000) duree = duree / 3600; // secondes → heures
        else if (duree > 24) duree = duree / 60; // minutes → heures
      } else if (shift.starts_at && shift.ends_at) {
        duree = durationHours(shift.starts_at, shift.ends_at);
        // Soustraire la pause si présente
        const pause = parseFloat(shift.break_duration || shift.pause || 0);
        if (pause > 0 && pause < 24) duree -= pause; // pause en heures
        else if (pause >= 24) duree -= pause / 60; // pause en minutes
      } else if (shift.worked_hours) {
        duree = parseFloat(shift.worked_hours);
      }

      // Ignorer les shifts de repos (0h ou négatifs)
      if (duree <= 0) continue;

      const type = (shift.shift_type || shift.type || shift.category || '').toLowerCase();
      if (type.includes('sup') || type.includes('overtime') || type.includes('extra')) {
        heures_sup += duree;
      } else if (type.includes('compl') || type.includes('complementary')) {
        heures_comp += duree;
      } else {
        heures_real += duree;
      }
    }

    return {
      heures_real: Math.round(heures_real * 100) / 100,
      heures_sup: Math.round(heures_sup * 100) / 100,
      heures_comp: Math.round(heures_comp * 100) / 100,
    };
  } catch (e) {
    console.warn(`  ⚠️  Shifts org ${orgId}: ${e.message} — fallback KPI`);
    return null; // null = utiliser les heures de l'API KPI
  }
}

// ─── SAVE KPIs avec heures corrigées depuis /shifts ───────────────────────────
async function saveKpis(mois, kpisJson) {
  const year = mois.slice(0, 4);
  const month = mois.slice(5, 7);
  const startDate = `${year}-${month}-01`;
  const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
  const endDate = `${year}-${month}-${String(lastDay).padStart(2, '0')}`;

  // Récupérer les orgs pour faire le lien nom → id
  const orgs = await getOrganisations();
  const orgByName = {};
  orgs.forEach(o => {
    const name = (o.name || o.label || o.organisation_name || '').trim();
    orgByName[name] = o.id || o.organisation_id;
  });

  const rows = [];

  for (const [name, val] of Object.entries(kpisJson)) {
    if (name === 'status' || typeof val !== 'object' || (!val.real && !val.predicted)) continue;

    const real = val.real || {};
    const predicted = val.predicted || {};
    const parcName = name.trim();

    // Heures depuis l'API KPI (valeur de base)
    let heures_real = parseFloat(real.worked_hours || 0);
    let heures_sup = parseHours(real.over_hours);
    let heures_comp = parseHours(real.complementary_hours);

    // Essayer de corriger avec les heures réelles des shifts
    const orgId = orgByName[parcName];
    if (orgId) {
      const shiftsH = await fetchHeuresShifts(orgId, startDate, endDate);
      if (shiftsH && shiftsH.heures_real > heures_real) {
        console.log(`  📊 ${parcName}: KPI=${heures_real}h → Shifts=${shiftsH.heures_real}h (correction appliquée)`);
        heures_real = shiftsH.heures_real;
        // Garder sup/comp de l'API KPI si shifts ne les distingue pas
        if (shiftsH.heures_sup > 0) heures_sup = shiftsH.heures_sup;
        if (shiftsH.heures_comp > 0) heures_comp = shiftsH.heures_comp;
      }
    } else {
      console.log(`  ⚠️  ${parcName}: pas d'orgId trouvé (orgs disponibles: ${Object.keys(orgByName).join(', ')})`);
    }

    rows.push({
      mois,
      parc: parcName,
      ms_real: parseFloat(real.salay_mass || real.salary_mass || 0),
      ms_predicted: parseFloat(predicted.salay_mass || predicted.salary_mass || 0),
      heures_real,
      heures_sup,
      heures_comp,
      ca_real: parseFloat(real.revenue || 0),
      ca_predicted: parseFloat(predicted.revenue || 0),
    });
  }

  console.log(`📤 KPIs upsert ${rows.length} parcs pour ${mois}`);
  rows.forEach(r => console.log(`   ${r.parc}: ${r.heures_real}h · MS: ${r.ms_real}€`));
  await sbUpsert('kpis', rows);
  return rows;
}

// ─── SAVE ABSENCES ────────────────────────────────────────────────────────────
async function saveAbsences(mois) {
  const year = mois.slice(0, 4);
  const month = mois.slice(5, 7);
  const startDate = `${year}-${month}-01`;
  const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
  const endDate = `${year}-${month}-${String(lastDay).padStart(2, '0')}`;
  const orgs = await getOrganisations();
  const rows = [];

  for (const org of orgs) {
    const orgId = org.id || org.organisation_id;
    const orgName = (org.name || org.label || org.organisation_name || String(orgId)).trim();
    try {
      const data = await skelloFetch('absences', { organisation_id: orgId, start_date: startDate, end_date: endDate });
      const absences = Array.isArray(data) ? data : (data.absences || data.data || []);
      console.log(`  📋 ${orgName}: ${absences.length} absences`);

      let jours_maladie = 0, jours_accident = 0, jours_injustifie = 0;
      let jours_conge_sans_solde = 0, jours_maternite_paternite = 0;

      for (const abs of absences) {
        const jours = parseFloat(abs.duration_days || abs.days || abs.duration || 1);
        const type = (abs.type || abs.reason || abs.absence_type || '').toLowerCase();
        if (type.includes('maladie') || type.includes('sick')) jours_maladie += jours;
        else if (type.includes('accident') || type.includes('injury')) jours_accident += jours;
        else if (type.includes('injustifi') || type.includes('unexcused')) jours_injustifie += jours;
        else if (type.includes('sans solde') || type.includes('unpaid')) jours_conge_sans_solde += jours;
        else if (type.includes('maternit') || type.includes('paternitit') || type.includes('parental')) jours_maternite_paternite += jours;
        else jours_maladie += jours;
      }

      rows.push({
        mois, parc: orgName,
        jours_maladie: Math.round(jours_maladie * 100) / 100,
        jours_accident: Math.round(jours_accident * 100) / 100,
        jours_injustifie: Math.round(jours_injustifie * 100) / 100,
        jours_conge_sans_solde: Math.round(jours_conge_sans_solde * 100) / 100,
        jours_maternite_paternite: Math.round(jours_maternite_paternite * 100) / 100,
      });
    } catch (e) { console.error(`  ❌ Absences ${orgName}:`, e.message); }
  }

  await sbUpsert('absenteisme', rows);
  return rows;
}

// ─── SAVE EFFECTIFS ───────────────────────────────────────────────────────────
async function saveEffectifs(mois) {
  const orgs = await getOrganisations();
  const rows = [];

  for (const org of orgs) {
    const orgId = org.id || org.organisation_id;
    const orgName = (org.name || org.label || org.organisation_name || String(orgId)).trim();
    try {
      let allEmp = [], page = 1;
      while (true) {
        const data = await skelloFetch('employees', { organisation_id: orgId, page, per_page: 200 });
        const emps = Array.isArray(data) ? data : (data.employees || data.data || []);
        if (!emps.length) break;
        allEmp = allEmp.concat(emps);
        if (emps.length < 200) break;
        page++;
      }
      console.log(`  👥 ${orgName}: ${allEmp.length} employés`);

      let nb_cdi=0, nb_cdd=0, nb_alternants=0, nb_stagiaires=0, nb_cadres=0, nb_non_cadres=0, total_anc=0;
      for (const emp of allEmp) {
        const c = (emp.contract_type || emp.employment_type || emp.type || '').toLowerCase();
        const cat = (emp.category || emp.job_category || emp.classification || '').toLowerCase();
        if (c.includes('cdi') || c.includes('permanent')) nb_cdi++;
        else if (c.includes('cdd') || c.includes('fixed')) nb_cdd++;
        else if (c.includes('alternance') || c.includes('apprenti')) nb_alternants++;
        else if (c.includes('stage') || c.includes('intern')) nb_stagiaires++;
        else nb_cdi++;
        if (cat.includes('cadre') || cat.includes('manager')) nb_cadres++;
        else nb_non_cadres++;
        const sd = emp.hired_at || emp.start_date || emp.created_at;
        if (sd) total_anc += (Date.now() - new Date(sd).getTime()) / (1000*60*60*24*365);
      }
      const eff = nb_cdi + nb_cdd + nb_alternants + nb_stagiaires;
      rows.push({
        mois, parc: orgName,
        nb_cdi, nb_cdd, nb_alternants, nb_stagiaires, nb_cadres, nb_non_cadres,
        effectif_total: eff,
        etp: eff,
        anciennete_moy: eff > 0 ? Math.round(total_anc/eff*10)/10 : 0,
      });
    } catch (e) { console.error(`  ❌ Effectifs ${orgName}:`, e.message); }
  }

  await sbUpsert('effectifs', rows);
  return rows;
}

// ─── CRON — 1er du mois à minuit ──────────────────────────────────────────────
function startCron() {
  setInterval(async () => {
    const now = new Date();
    if (now.getDate() === 1 && now.getHours() === 0 && now.getMinutes() < 5) {
      const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const mois = prev.toISOString().slice(0, 10);
      console.log(`🕛 Cron: sauvegarde complète ${mois}`);
      try {
        const kpisData = await fetchSkelloKpis(mois);
        await Promise.all([saveKpis(mois, kpisData), saveAbsences(mois), saveEffectifs(mois)]);
        console.log(`✅ Cron terminé ${mois}`);
      } catch(e) { console.error('❌ Cron:', e.message); }
    }
  }, 5 * 60 * 1000);
  console.log('⏰ Cron job démarré (vérification toutes les 5 min)');
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.get('/api/kpis', async (req, res) => {
  try {
    const { date } = req.query;
    const data = await fetchSkelloKpis(date);
    if (date) {
      const mois = date.slice(0, 7) + '-01';
      saveKpis(mois, data).catch(e => console.error('Save error:', e.message));
    }
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Recalculer les heures depuis les shifts pour un mois (correction des heures)
app.post('/api/fix-heures/:mois', async (req, res) => {
  try {
    const mois = req.params.mois + '-01';
    console.log(`🔧 Correction heures depuis shifts pour ${mois}`);
    const kpisData = await fetchSkelloKpis(mois);
    const rows = await saveKpis(mois, kpisData);
    res.json({ ok: true, mois, parcs: rows.map(r => ({ parc: r.parc, heures: r.heures_real })) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/save-absences/:mois', async (req, res) => {
  try {
    const rows = await saveAbsences(req.params.mois + '-01');
    res.json({ ok: true, mois: req.params.mois, parcs: rows.length, data: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/save-effectifs/:mois', async (req, res) => {
  try {
    const rows = await saveEffectifs(req.params.mois + '-01');
    res.json({ ok: true, mois: req.params.mois, parcs: rows.length, data: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/save/:mois', async (req, res) => {
  try {
    const mois = req.params.mois;
    const date = mois + '-01';
    console.log(`📥 Sauvegarde complète ${date}`);
    const kpisData = await fetchSkelloKpis(date);
    const [kpi, abs, eff] = await Promise.allSettled([
      saveKpis(date, kpisData),
      saveAbsences(date),
      saveEffectifs(date),
    ]);
    res.json({ ok: true, mois, kpis: kpi.status, absences: abs.status, effectifs: eff.status });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/history', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(503).json({ error: 'Supabase non configuré' });
  try {
    const { parc, limit = 13 } = req.query;
    let url = `${SUPABASE_URL}/rest/v1/kpis?select=*&order=mois.desc&limit=${limit}`;
    if (parc) url += `&parc=eq.${encodeURIComponent(parc)}`;
    const r = await fetch(url, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/n1', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.json([]);
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date requis' });
    const n1 = new Date(date);
    n1.setFullYear(n1.getFullYear() - 1);
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/kpis?select=*&mois=eq.${n1.toISOString().slice(0,10)}`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Debug: voir ce que Skello retourne brut pour les shifts
app.get('/api/debug-shifts/:mois', async (req, res) => {
  try {
    const mois = req.params.mois + '-01';
    const year = mois.slice(0,4), month = mois.slice(5,7);
    const startDate = `${year}-${month}-01`;
    const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
    const endDate = `${year}-${month}-${String(lastDay).padStart(2,'0')}`;
    const orgs = await getOrganisations();
    const results = {};
    for (const org of orgs.slice(0, 2)) { // limiter à 2 orgs pour le debug
      const orgId = org.id || org.organisation_id;
      const name = (org.name || org.label || '').trim();
      try {
        const data = await skelloFetch('shifts', { organisation_id: orgId, start_date: startDate, end_date: endDate, per_page: 5 });
        const shifts = Array.isArray(data) ? data : (data.shifts || data.data || []);
        results[name] = { count: shifts.length, sample: shifts[0] || null };
      } catch(e) { results[name] = { error: e.message }; }
    }
    res.json({ mois, orgs: orgs.map(o=>({id:o.id||o.organisation_id,name:(o.name||o.label||'').trim()})), shifts_sample: results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.use((req, res) => res.status(404).json({ error: 'Route introuvable' }));

app.listen(PORT, () => {
  console.log('✅ Proxy démarré sur port ' + PORT);
  startCron();
});
