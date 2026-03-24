# Israeli Bank Scraper Service

Standalone microservice for scraping Israeli bank transactions using [israeli-bank-scrapers](https://github.com/eshaham/israeli-bank-scrapers).

## Why a separate service?

The `israeli-bank-scrapers` package requires Puppeteer with bundled Chromium, which:
- Is 400+ MB and fails to build on serverless platforms (Vercel)
- Works fine on full Node.js environments (Railway, Render, Fly.io)
- Should be isolated from the main API for reliability and scaling

## Local Development

```bash
npm install
npm start
```

Server runs on port 3001 (or `$PORT` environment variable).

## Endpoints

### GET /health
Health check.
```bash
curl http://localhost:3001/health
```

### GET /banks
List available Israeli banks.
```bash
curl http://localhost:3001/banks
```

### POST /scrape
Scrape transactions from an Israeli bank.
```bash
curl -X POST http://localhost:3001/scrape \
  -H "Content-Type: application/json" \
  -d '{
    "bankId": "hapoalim",
    "username": "your-username",
    "password": "your-password"
  }'
```

**Response:**
```json
{
  "success": true,
  "accounts": [
    {
      "id": "123456789",
      "name": "Checking Account",
      "type": "checking",
      "balance": 10000
    }
  ],
  "transactions": [
    {
      "date": "2026-03-24",
      "description": "Supermarket purchase",
      "amount": -150.00,
      "category": "Groceries",
      "merchant": "Supermarket",
      "source": "israeli_bank_scraper"
    }
  ],
  "transactionCount": 25
}
```

## Deployment to Railway

1. Go to [railway.app](https://railway.app)
2. Create new project → Deploy from GitHub
3. Select this repository/directory
4. Railway auto-detects Node.js, installs dependencies, and runs `npm start`
5. Get the deployed URL (e.g., `https://your-service-production.up.railway.app`)

## Integration with Main API

From the main Vercel backend (`/api/israel/login`):

```javascript
const scraperURL = process.env.SCRAPER_SERVICE_URL || 'http://localhost:3001';

const response = await fetch(`${scraperURL}/scrape`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ bankId, username, password })
});

const result = await response.json();
// Store result.transactions in session, return sessionId
```

## Environment Variables

- `PORT` - Server port (default: 3001)
- `NODE_ENV` - Environment (default: production on Railway)

## Supported Banks

See [israeli-bank-scrapers documentation](https://github.com/eshaham/israeli-bank-scrapers#supported-banks).

Common banks:
- hapoalim
- leumi
- discount
- mizrahi
- otsar
- fibi
- union
- beinleumi

## Notes

- Chromium is automatically installed by Puppeteer on first run
- Scraping can take 30-60 seconds per account
- Bank credentials are never stored - they're only used during the scrape
- Add request timeout handling in the main API (30+ seconds)
# Updated - Railway deployment triggered
# Updated - triggering deployment
