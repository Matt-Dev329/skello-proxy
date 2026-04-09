const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json());

const AUTH_BASE = 'https://api.skello.io';
const API_KEY = process.env.SKELLO_TOKEN;

let jwtToken = null;
let jwtExpiry = 0;

async function getJWT() {
  if (jwtToken && Date.now() < jwtExpiry) return jwtToken;
  const res = await fetch(`${AUTH_BASE}/v1/jwt_token`, {
    method: 'POST',
    headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' }
  });
  const data = await res.json();
  jwtToken = data.jwt || data.access_token || data.token;
  jwtExpiry = Date.now() + 50 * 60 * 1000;
  return jwtToken;
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/api/kpis', async (req, res) => {
  try {
    const jwt = await getJWT();
    const { date, per_week } = req.query;
    const url = new URL(`https://api.skello.io/public/v1/kpis`);
    if (date) url.searchParams.set('date', date);
    if (per_week !== undefined) url.searchParams.set('per_week', per_week);
    const r = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' }
    });
    const data = await r.json();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Route introuvable' }));

app.listen(PORT, () => console.log(`✅ Proxy démarré sur http://localhost:${PORT}`));
