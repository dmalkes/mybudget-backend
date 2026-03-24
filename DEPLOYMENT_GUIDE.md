# GuiaBolso 2.0 - Deployment Guide

## Architecture Overview

**Multi-service architecture:**
- **Main API** (Vercel): Handles uploads, Pluggy integration, user sessions
- **Israeli Scraper Service** (Railway): Handles Israeli bank scraping with Chromium
- **Frontend** (Vercel): Web app

---

## 1. Deploy Israeli Scraper Service to Railway

The scraper service needs to run on a platform that supports native dependencies (Chromium).

### Step 1: Create Railway Account
1. Go to [railway.app](https://railway.app)
2. Sign up with GitHub
3. Create a new organization if prompted

### Step 2: Deploy Scraper Service
1. Create a new project
2. Select "Deploy from GitHub"
3. Select your repository: `dmalkes/mybudget-backend`
4. Choose to deploy the `israeli-scraper-service` directory (or entire repo)
5. Railway auto-detects Node.js
6. Wait for build to complete (~3-5 minutes)

### Step 3: Get Railway URL
After deployment, you'll get a URL like:
```
https://mybudget-scraper-production.up.railway.app
```

Test it:
```bash
curl https://mybudget-scraper-production.up.railway.app/health
# Should return: {"status":"ok","service":"israeli-bank-scraper"}
```

### Step 4: Connect to Vercel
1. Go to [Vercel Dashboard](https://vercel.com)
2. Select your `mybudget-backend` deployment
3. Settings → Environment Variables
4. Add new variable:
   - **Key**: `SCRAPER_SERVICE_URL`
   - **Value**: `https://mybudget-scraper-production.up.railway.app`
5. Deploy → Redeploy

Test the connection:
```bash
curl https://mybudget-api.vercel.app/api/version
# Should show: "scraperServiceUrl":"https://mybudget-scraper-production.up.railway.app"
```

### Step 5: Test Israeli Bank Endpoints
```bash
# Get list of banks
curl https://mybudget-api.vercel.app/api/israel/banks

# Should return JSON with bank list (no credentials needed)
```

---

## 2. Deploy Main API to Vercel (Already Done)

No additional steps needed. The main API is already deployed and will automatically use the scraper service once `SCRAPER_SERVICE_URL` environment variable is set.

---

## 3. Required Environment Variables

### Vercel (mybudget-api.vercel.app)
- `PLUGGY_CLIENT_ID` - Pluggy SDK client ID (for Brazil)
- `PLUGGY_CLIENT_SECRET` - Pluggy SDK client secret
- `SCRAPER_SERVICE_URL` - Railway scraper service URL (e.g., `https://mybudget-scraper-production.up.railway.app`)

### Railway (Israeli Scraper)
No environment variables needed - it works out of the box.

---

## 4. Testing End-to-End

### Test in Development (Local)

Terminal 1 - Start scraper service:
```bash
cd israeli-scraper-service
npm install
npm start
# Runs on http://localhost:3001
```

Terminal 2 - Start main API:
```bash
cd backend
npm install
npm start
# Runs on http://localhost:3000
# Automatically detects scraper at localhost:3001
```

Terminal 3 - Test frontend:
```bash
# Open http://localhost:3000 in browser
# Select Israel as country
# Click "Connect Your Bank (Israel)"
```

### Test in Production (After Railway Deployment)

1. Go to https://mybudget-api.vercel.app
2. Select Israel as country
3. Click "Connect Your Bank (Israel)"
4. You should see a list of Israeli banks
5. Try connecting with test credentials (if you have them)

---

## 5. Monitoring & Troubleshooting

### Check Scraper Service Health
```bash
# Production
curl https://mybudget-scraper-production.up.railway.app/health

# Local development
curl http://localhost:3001/health
```

### Check Main API Connection to Scraper
```bash
curl https://mybudget-api.vercel.app/api/version
```

If `scraperServiceUrl` is "not configured", make sure:
1. Environment variable `SCRAPER_SERVICE_URL` is set in Vercel
2. Railway service is deployed and running
3. The URL is correct (test with `/health` endpoint)

### View Scraper Service Logs
In Railway dashboard:
1. Select your project
2. Click on the service
3. View logs in real-time

### Common Issues

**Timeout Error (504 Gateway Timeout)**
- Scraping took too long (>90 seconds)
- Bank might be slow or credentials might be incorrect
- Israeli banks can take 30-60 seconds to scrape

**503 Service Unavailable**
- Scraper service is not running or not reachable
- Check `SCRAPER_SERVICE_URL` environment variable
- Check Railway deployment status

**Bank List Returns Empty**
- Scraper service might be down
- Check health endpoint: `https://mybudget-scraper.../health`

---

## 6. Cost Estimation

### Railway
- **Free tier**: 500 hours/month (plenty for a scraper service)
- **Paid**: ~$5/month for continuous service
- Usage: Only active when users actually connect banks

### Vercel
- **Free tier**: 100 GB bandwidth/month (covers most apps)
- **Paid**: $20/month for additional features

---

## 7. Future Improvements

### Short term:
- [ ] Add request queuing (avoid thundering herd)
- [ ] Add caching for bank list (doesn't change often)
- [ ] Add rate limiting per IP/user
- [ ] Add better error messages for specific bank failures

### Medium term:
- [ ] Switch to Finanda or similar API when budget allows
- [ ] Add support for EU banks (Plaid integration)
- [ ] Add support for US banks (Plaid)

---

## Quick Deployment Checklist

- [ ] Create Railway account
- [ ] Deploy scraper service to Railway
- [ ] Get Railway URL
- [ ] Add `SCRAPER_SERVICE_URL` to Vercel env vars
- [ ] Redeploy Vercel
- [ ] Test `/api/israel/banks` endpoint
- [ ] Test full flow in app

---

## Support

If you hit issues during deployment, check:
1. Railway logs (in dashboard)
2. Vercel logs (in dashboard)
3. Browser console (for frontend errors)
4. This guide's troubleshooting section
