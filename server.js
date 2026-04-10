const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.SKELLO_TOKEN;

let jwtToken = null;
let jwtExpiry = 0;

async function getJWT() {
  if (jwtToken && Date.now() < jwtExpiry) return jwtToken;
  
  // Essai 1 : token dans le body
  let res = await fetch('https://api.skello.io/v1/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ token: API_KEY })
  });
  console.log('Login body attempt:', res.status);
  
  // Essai 2 : token dans header X-Api-Key + body vide
  if (!res.ok) {
    res = await fetch('https://api.skello.io/v1/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-Api-Key': API_KEY },
      body: '{}'
    });
    console.log('Login header attempt:', res.status);
  }

  // Essai 3 : access_key dans le body
  if (!res.ok) {
    res = await fetch('https://api.skello.io/v1/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ access_key: API_KEY })
    });
    console.log('Login access_key attempt:', res.status);
  }

  const text = await res.text();
  console.log('Login final response:', res.status, text.slice(0, 300));
  
  if (!res.ok) throw new Error('Login failed: ' + res.status + ' ' + text);
  
  const data = JSON.parse(text);
  jwtToken = data.token || data.jwt || data.access_token;
  jwtExpiry = Date.now() + 14 * 60 * 1000; // 14 min (token valide 15 min)
  console.log('JWT obtained:', jwtToken ? 'OK' : 'NULL');
  return jwtToken;
}

app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.get('/api/kpis', async (req, res) => {
  try {
    const jwt = await getJWT();
    const { date, per_week } = req.query;
    const url = new URL('https://api.skello.io/public/v1/kpis');
    if (date) url.searchParams.set('date', date);
    if (per_week !== undefined) url.searchParams.set('per_week', per_week);
    
    const r = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${jwt}`, 'Accept': 'application/json' }
    });
    const text = await r.text();
    console.log('KPIs response:', r.status, text.slice(0, 300));
    res.status(r.status).send(text);
  } catch(e) {
    console.error('Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Route introuvable' }));
app.listen(PORT, () => console.log('✅ Proxy démarré sur port ' + PORT));
