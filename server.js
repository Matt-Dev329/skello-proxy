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

  // Login sur auth.skello.io avec X-Api-Key dans le header
  const res = await fetch('https://auth.skello.io/v1/login', {
    method: 'POST',
    headers: {
      'X-Api-Key': API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: '{}'
  });

  const text = await res.text();
  console.log('Login response:', res.status, text.slice(0, 400));

  if (!res.ok) throw new Error('Login failed: ' + res.status + ' ' + text);

  const data = JSON.parse(text);
  jwtToken = data.token || data.jwt || data.access_token;
  jwtExpiry = Date.now() + 14 * 60 * 1000;
  console.log('JWT obtained:', jwtToken ? jwtToken.slice(0,20)+'...' : 'NULL');
  return jwtToken;
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/api/kpis', async (req, res) => {
  try {
    const jwt = await getJWT();
    const { date, per_week } = req.query;
    const url = new URL('https://api.skello.io/public/v1/kpis');
    if (date) url.searchParams.set('date', date);
    if (per_week !== undefined) url.searchParams.set('per_week', per_week);

    const r = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'Accept': 'application/json'
      }
    });
    const text = await r.text();
    console.log('KPIs:', r.status, text.slice(0, 400));
    res.status(r.status).send(text);
  } catch(e) {
    console.error('Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Route introuvable' }));
app.listen(PORT, () => console.log('✅ Proxy sur port ' + PORT));
