# Proxy Skello — Tableau KPI RH Multi-parcs

Proxy backend sécurisé qui relaie les appels à l'API Skello sans exposer le token dans le navigateur.

---

## 🚀 Démarrage rapide (5 minutes)

### 1. Prérequis
- Node.js 18+ installé : https://nodejs.org
- Votre token Skello (disponible dans Skello > Paramètres > Outils partenaires)

### 2. Installation

```bash
# Dans le dossier skello-proxy/
npm install
```

### 3. Configuration

Le fichier `.env` est déjà créé avec votre token. Vérifiez-le :

```
SKELLO_TOKEN=xyyNUhIDEksNxkfra8IK   ← à régénérer si besoin
PORT=3001
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5173
```

### 4. Lancement

```bash
# Développement (avec rechargement auto)
npm run dev

# Production
npm start
```

Le proxy démarre sur **http://localhost:3001**

### 5. Ouvrir le dashboard

Ouvrez le fichier `public/dashboard.html` dans votre navigateur.
Ou servez-le avec un serveur local :

```bash
npx serve public/
# → http://localhost:3000
```

---

## 📡 Endpoints disponibles

| Route | Description | Params |
|-------|-------------|--------|
| `GET /health` | Santé du proxy | — |
| `GET /api/organisations` | Liste de tous les parcs | — |
| `GET /api/employees` | Liste des employés | `organisation_id`, `page`, `per_page` |
| `GET /api/absences` | Absences | `organisation_id`, `start_date`, `end_date` |
| `GET /api/shifts` | Plannings / shifts | `organisation_id`, `start_date`, `end_date` |
| `GET /api/analytics` | Données analytiques | `organisation_id`, `start_date`, `end_date` |
| `GET /api/kpis` | KPIs agrégés multi-parcs | `start_date`, `end_date` |

### Exemple d'appel

```bash
curl http://localhost:3001/api/organisations
curl "http://localhost:3001/api/employees?organisation_id=123&per_page=50"
curl "http://localhost:3001/api/absences?start_date=2026-03-01&end_date=2026-03-31"
```

---

## ☁️ Déploiement en production

### Option A — Railway (recommandé, gratuit)

1. Créez un compte sur https://railway.app
2. Nouveau projet > Deploy from GitHub
3. Ajoutez les variables d'environnement dans Railway :
   - `SKELLO_TOKEN` = votre_token
   - `ALLOWED_ORIGINS` = https://votre-dashboard.com
4. Railway vous donne une URL type : `https://skello-proxy-production.up.railway.app`
5. Dans le dashboard HTML, sélectionnez "URL personnalisée" et entrez cette URL

### Option B — Render (gratuit)

1. https://render.com > New Web Service
2. Connectez votre repo GitHub
3. Build command : `npm install`
4. Start command : `npm start`
5. Ajoutez les variables d'environnement

### Option C — VPS / serveur existant

```bash
# Sur votre serveur
git clone <votre-repo>
cd skello-proxy
npm install
cp .env.example .env
# Éditez .env avec votre token et votre domaine
npm start

# Avec PM2 (redémarrage automatique)
npm install -g pm2
pm2 start src/server.js --name skello-proxy
pm2 save && pm2 startup
```

### Nginx (reverse proxy)

```nginx
server {
    listen 443 ssl;
    server_name proxy.mondomaine.com;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

---

## 🔒 Sécurité

- Le token Skello n'est **jamais** envoyé au navigateur
- CORS configuré : seules les origines autorisées dans `.env` peuvent appeler le proxy
- Rate limiting : 100 req / 15 min par IP
- Cache mémoire 5 min pour réduire les appels à Skello
- Le fichier `.env` est dans `.gitignore` — ne le commitez jamais

### ⚠️ À faire impérativement

1. **Régénérez votre token Skello** (il a été exposé dans une conversation)
   > Skello > Paramètres établissement > Outils partenaires > Générer un nouveau token
2. Mettez le nouveau token dans `.env`
3. Mettez à jour `ALLOWED_ORIGINS` avec votre vrai domaine en production

---

## 🏗️ Structure

```
skello-proxy/
├── src/
│   └── server.js          ← Proxy principal
├── public/
│   └── dashboard.html     ← Dashboard KPI RH complet
├── .env                   ← Config (token, ports) — NE PAS COMMITTER
├── .env.example           ← Template sans secrets
├── .gitignore
├── package.json
└── README.md
```
