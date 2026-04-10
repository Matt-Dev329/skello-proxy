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

// Upsert générique vers Supabase
async function sbUpsert(table, rows) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  if (!rows.length) { console.log(`⚠️  ${table}: aucune ligne à sauvegarder`); return; }

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

// Fetch paginé Skello
async function skelloFetch(path, params = {}) {
  const jwt = await getJWT();
  const url = new URL(`https://api.skello.io/public/v1/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${jwt}`, 'Accept': 'application/json' }
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path} failed: ${r.status} — ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

// Récupérer toutes les organisations
async function getOrganisations() {
  const data = await skelloFetch('organisations');
  return Array.isArray(data) ? data : (data.organisations || data.data || []);
}

// ─── SAVE KPIs ────────────────────────────────────────────────────────────────
async function saveKpis(mois, kpisJson) {
  const rows = Object.entries(kpisJson)
    .filter(([name, val]) => name !== 'status' && typeof val === 'object' && (val.real || val.predicted))
    .map(([name, val]) => {
      const real = val.real || {};
      const predicted = val.predicted || {};
      return {
        mois,
        parc: name.trim(),
        ms_real: parseFloat(real.salay_mass || real.salary_mass || 0),
        ms_predicted: parseFloat(predicted.salay_mass || predicted.salary_mass || 0),
        heures_real: parseFloat(real.worked_hours || 0),
        ca_real: parseFloat(real.revenue || 0),
        ca_predicted: parseFloat(predicted.revenue || 0),
        heures_sup: parseHours(real.over_hours),
        heures_comp: parseHours(real.complementary_hours),
      };
    });
  console.log(`📤 KPIs upsert ${rows.length} parcs pour ${mois}:`, rows.map(r => r.parc));
  await sbUpsert('kpis', rows);
}

// ─── SAVE ABSENCES ────────────────────────────────────────────────────────────
async function saveAbsences(mois) {
  // mois = "2026-04-01"
  const year = mois.slice(0, 4);
  const month = mois.slice(5, 7);
  const startDate = `${year}-${month}-01`;
  const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
  const endDate = `${year}-${month}-${String(lastDay).padStart(2, '0')}`;

  const orgs = await getOrganisations();
  console.log(`🏢 ${orgs.length} organisations trouvées`);

  const rows = [];

  for (const org of orgs) {
    const orgId = org.id || org.organisation_id;
    const orgName = (org.name || org.label || org.organisation_name || String(orgId)).trim();

    try {
      const data = await skelloFetch('absences', {
        organisation_id: orgId,
        start_date: startDate,
        end_date: endDate
      });

      const absences = Array.isArray(data) ? data : (data.absences || data.data || []);
      console.log(`  📋 ${orgName}: ${absences.length} absences`);

      // Agréger par motif
      let jours_maladie = 0, jours_accident = 0, jours_injustifie = 0;
      let jours_conge_sans_solde = 0, jours_maternite_paternite = 0;

      for (const abs of absences) {
        const jours = parseFloat(abs.duration_days || abs.days || abs.duration || 1);
        const type = (abs.type || abs.reason || abs.absence_type || '').toLowerCase();

        if (type.includes('maladie') || type.includes('sick') || type.includes('illness')) {
          jours_maladie += jours;
        } else if (type.includes('accident') || type.includes('injury') || type.includes('work')) {
          jours_accident += jours;
        } else if (type.includes('injustifi') || type.includes('unexcused') || type.includes('unexplained')) {
          jours_injustifie += jours;
        } else if (type.includes('sans solde') || type.includes('unpaid') || type.includes('css')) {
          jours_conge_sans_solde += jours;
        } else if (type.includes('maternit') || type.includes('paternitit') || type.includes('parental') || type.includes('congé parental')) {
          jours_maternite_paternite += jours;
        } else {
          // Inconnu → maladie par défaut
          jours_maladie += jours;
        }
      }

      rows.push({
        mois,
        parc: orgName,
        jours_maladie: Math.round(jours_maladie * 100) / 100,
        jours_accident: Math.round(jours_accident * 100) / 100,
        jours_injustifie: Math.round(jours_injustifie * 100) / 100,
        jours_conge_sans_solde: Math.round(jours_conge_sans_solde * 100) / 100,
        jours_maternite_paternite: Math.round(jours_maternite_paternite * 100) / 100,
        // jours_total et taux calculés automatiquement par trigger Supabase
      });

    } catch (e) {
      console.error(`  ❌ Absences ${orgName}:`, e.message);
    }
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
      // Récupérer les employés (paginé, max 200 par appel)
      let allEmployees = [];
      let page = 1;
      while (true) {
        const data = await skelloFetch('employees', {
          organisation_id: orgId,
          page,
          per_page: 200
        });
        const emps = Array.isArray(data) ? data : (data.employees || data.data || []);
        if (!emps.length) break;
        allEmployees = allEmployees.concat(emps);
        if (emps.length < 200) break;
        page++;
      }

      console.log(`  👥 ${orgName}: ${allEmployees.length} employés`);

      // Compter par type de contrat
      let nb_cdi = 0, nb_cdd = 0, nb_alternants = 0, nb_stagiaires = 0;
      let nb_cadres = 0, nb_non_cadres = 0;
      let total_anciennete = 0;

      for (const emp of allEmployees) {
        const contrat = (emp.contract_type || emp.employment_type || emp.type || '').toLowerCase();
        const statut = (emp.status || emp.employee_status || '').toLowerCase();
        const categorie = (emp.category || emp.job_category || emp.classification || '').toLowerCase();

        if (contrat.includes('cdi') || contrat.includes('permanent') || contrat.includes('indefinite')) nb_cdi++;
        else if (contrat.includes('cdd') || contrat.includes('fixed') || contrat.includes('temporary')) nb_cdd++;
        else if (contrat.includes('alternance') || contrat.includes('apprenti') || contrat.includes('apprentice')) nb_alternants++;
        else if (contrat.includes('stage') || contrat.includes('intern') || contrat.includes('stagiaire')) nb_stagiaires++;
        else nb_cdi++; // défaut CDI

        if (categorie.includes('cadre') || categorie.includes('manager') || categorie.includes('executive')) nb_cadres++;
        else nb_non_cadres++;

        // Ancienneté
        const startDate = emp.hired_at || emp.start_date || emp.created_at;
        if (startDate) {
          const years = (Date.now() - new Date(startDate).getTime()) / (1000 * 60 * 60 * 24 * 365);
          total_anciennete += years;
        }
      }

      const effectif_total = nb_cdi + nb_cdd + nb_alternants + nb_stagiaires;
      const anciennete_moy = effectif_total > 0 ? Math.round((total_anciennete / effectif_total) * 10) / 10 : 0;

      rows.push({
        mois,
        parc: orgName,
        nb_cdi,
        nb_cdd,
        nb_alternants,
        nb_stagiaires,
        nb_cadres,
        nb_non_cadres,
        effectif_total, // aussi calculé par trigger
        etp: effectif_total, // approximation, Skello ne donne pas toujours l'ETP
        anciennete_moy,
      });

    } catch (e) {
      console.error(`  ❌ Effectifs ${orgName}:`, e.message);
    }
  }

  await sbUpsert('effectifs', rows);
  return rows;
}

// ─── FETCH SKELLO KPIS ────────────────────────────────────────────────────────
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

// ─── CRON JOB — 1er de chaque mois à minuit ──────────────────────────────────
function startCron() {
  const checkAndRun = async () => {
    const now = new Date();
    if (now.getDate() === 1 && now.getHours() === 0 && now.getMinutes() < 5) {
      const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const mois = prevMonth.toISOString().slice(0, 10);
      console.log(`🕛 Cron: sauvegarde complète de ${mois}`);
      try {
        const [kpisData] = await Promise.all([
          fetchSkelloKpis(mois),
        ]);
        await Promise.all([
          saveKpis(mois, kpisData),
          saveAbsences(mois),
          saveEffectifs(mois),
        ]);
        console.log(`✅ Cron terminé pour ${mois}`);
      } catch (e) {
        console.error('❌ Cron error:', e.message);
      }
    }
  };
  setInterval(checkAndRun, 5 * 60 * 1000);
  console.log('⏰ Cron job démarré (vérification toutes les 5 min)');
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// KPIs live depuis Skello + sauvegarde auto
app.get('/api/kpis', async (req, res) => {
  try {
    const { date } = req.query;
    const data = await fetchSkelloKpis(date);
    if (date) {
      const mois = date.slice(0, 7) + '-01';
      saveKpis(mois, data).catch(e => console.error('KPIs save error:', e.message));
    }
    res.json(data);
  } catch (e) {
    console.error('Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Sauvegarde absences pour un mois
app.post('/api/save-absences/:mois', async (req, res) => {
  try {
    const mois = req.params.mois + '-01'; // ex: 2026-04 → 2026-04-01
    console.log(`📥 Sauvegarde absences ${mois}`);
    const rows = await saveAbsences(mois);
    res.json({ ok: true, mois, parcs: rows.length, data: rows });
  } catch (e) {
    console.error('❌', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Sauvegarde effectifs pour un mois
app.post('/api/save-effectifs/:mois', async (req, res) => {
  try {
    const mois = req.params.mois + '-01'; // ex: 2026-04 → 2026-04-01
    console.log(`📥 Sauvegarde effectifs ${mois}`);
    const rows = await saveEffectifs(mois);
    res.json({ ok: true, mois, parcs: rows.length, data: rows });
  } catch (e) {
    console.error('❌', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Sauvegarde TOUT pour un mois (KPIs + absences + effectifs)
app.post('/api/save/:mois', async (req, res) => {
  try {
    const mois = req.params.mois; // ex: 2026-04
    const date = mois + '-01';
    console.log(`📥 Sauvegarde complète de ${date}`);

    const kpisData = await fetchSkelloKpis(date);
    const [kpiResult, absResult, effResult] = await Promise.allSettled([
      saveKpis(date, kpisData),
      saveAbsences(date),
      saveEffectifs(date),
    ]);

    res.json({
      ok: true,
      mois,
      kpis: kpiResult.status,
      absences: absResult.status,
      effectifs: effResult.status,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Historique depuis Supabase
app.get('/api/history', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(503).json({ error: 'Supabase non configuré' });
  try {
    const { parc, limit = 13 } = req.query;
    let url = `${SUPABASE_URL}/rest/v1/kpis?select=*&order=mois.desc&limit=${limit}`;
    if (parc) url += `&parc=eq.${encodeURIComponent(parc)}`;
    const r = await fetch(url, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// N-1 depuis Supabase
app.get('/api/n1', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.json([]);
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date requis' });
    const n1Date = new Date(date);
    n1Date.setFullYear(n1Date.getFullYear() - 1);
    const n1 = n1Date.toISOString().slice(0, 10);
    const r = await fetch(`${SUPABASE_URL}/rest/v1/kpis?select=*&mois=eq.${n1}`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Route introuvable' }));

app.listen(PORT, () => {
  console.log('✅ Proxy démarré sur port ' + PORT);
  startCron();
});
