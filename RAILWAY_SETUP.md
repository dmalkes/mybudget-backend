# Railway Auto-Deployment Setup

## What's Ready

✅ GitHub Actions workflow configured (`.github/workflows/deploy-scraper.yml`)
✅ Railway.json deployment config added (`israeli-scraper-service/railway.json`)
✅ All code committed and pushed

Now you just need to **connect your GitHub to Railway** (one-time setup, takes 2 minutes).

---

## Step-by-Step Setup

### 1. Create Railway Account
Go to **https://railway.app** and sign up with GitHub
- Click "Sign in with GitHub"
- Authorize the Railway app to access your repos

### 2. Generate Railway Token
1. Go to **Account Settings** (click avatar → Settings)
2. Go to **Tokens** tab
3. Click **Create New Token**
4. Name it: `GITHUB_ACTIONS`
5. Copy the token (you'll need it in 30 seconds)

### 3. Add Token to GitHub
1. Go to your GitHub repo: `https://github.com/dmalkes/mybudget-backend`
2. Settings → Secrets and variables → Actions
3. Click **New repository secret**
4. Name: `RAILWAY_TOKEN`
5. Value: (paste the token from Step 2)
6. Click **Add secret**

### 4. Test the Workflow
1. Make a small change to `/israeli-scraper-service/` (e.g., update README)
2. Push to main
3. Go to **Actions** tab in GitHub
4. You should see "Deploy Israeli Scraper to Railway" workflow running
5. Wait 3-5 minutes for build to complete

### 5. Get Your Railway URL
Once the workflow completes successfully:
1. Go to **railway.app** dashboard
2. Click your project
3. You'll see `mybudget-israeli-scraper` service
4. Click on it
5. Copy the domain URL (looks like: `https://mybudget-israeli-scraper-production.up.railway.app`)

### 6. Add to Vercel
1. Go to **Vercel Dashboard** → mybudget-api deployment
2. Settings → Environment Variables
3. Add new variable:
   - **Key**: `SCRAPER_SERVICE_URL`
   - **Value**: (paste the Railway URL from Step 5)
4. Click **Save**
5. Vercel will auto-redeploy

### 7. Verify It Works
```bash
# Test the connection
curl https://mybudget-api.vercel.app/api/version

# Should show:
# {"scraperServiceUrl":"https://mybudget-israeli-scraper-production.up.railway.app",...}

# Test getting bank list
curl https://mybudget-api.vercel.app/api/israel/banks

# Should return a JSON list of banks
```

---

## What Happens Next

- Every time you push changes to `israeli-scraper-service/`, GitHub Actions automatically:
  1. Builds the service
  2. Deploys it to Railway
  3. Updates the running service (no downtime)
- Your Vercel API will call the updated scraper automatically

---

## Troubleshooting

### Workflow shows error in GitHub Actions
- Check that `RAILWAY_TOKEN` secret was added correctly
- Make sure the token is valid (not expired)
- Try regenerating a new token in Railway

### Scraper service won't deploy
- Check Railway logs in dashboard
- Common issue: Node version mismatch
  - Railway uses Node 22+ by default (already configured in railway.json)

### Getting 503 error from /api/israel/banks
- Scraper service might still be deploying
- Check Railway dashboard to see deployment status
- Make sure `SCRAPER_SERVICE_URL` is set in Vercel

### Connection timeout when scraping
- Bank scraping can take 30-60 seconds
- The backend has a 90-second timeout
- If timeout happens, user can retry

---

## Quick Links

- Railway Dashboard: https://railway.app
- GitHub Actions: https://github.com/dmalkes/mybudget-backend/actions
- Vercel Dashboard: https://vercel.com
- Repository: https://github.com/dmalkes/mybudget-backend

---

## How to Monitor After Setup

### View Scraper Logs (Real-time)
1. Go to Railway dashboard
2. Select your project
3. Click on `mybudget-israeli-scraper`
4. Click **Logs** tab

### View Deployment History
1. GitHub: Actions tab
2. Railway: Deployments tab

### Test Scraper Directly (Advanced)
```bash
# Get list of banks
curl https://[your-railway-url]/banks

# Test scrape (requires real credentials)
curl -X POST https://[your-railway-url]/scrape \
  -H "Content-Type: application/json" \
  -d '{
    "bankId": "hapoalim",
    "username": "test",
    "password": "test"
  }'
```

---

## Done! 🎉

Once the Railway URL is added to Vercel, your full integration is live:
- ✅ Brazil: Pluggy bank connections (production)
- ✅ Israel: Real bank scraping with Chromium (production)
- ✅ Auto-deployment: Changes push → GitHub → Railway (automatic)
# Deployment triggered
