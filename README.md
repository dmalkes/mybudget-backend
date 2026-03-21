# MyBudget Backend

Simple Express server that proxies file parsing requests to Claude API.

## Setup

1. Create a new GitHub repository (e.g., `mybudget-backend`)
2. Push these files to the repository
3. Deploy to Vercel (see instructions below)
4. Add your Anthropic API key to Vercel environment variables

## Deploy to Vercel

1. Go to https://vercel.com
2. Click "New Project"
3. Select "Import Git Repository"
4. Paste your GitHub repo URL
5. Click "Import"
6. In "Environment Variables":
   - Name: `ANTHROPIC_API_KEY`
   - Value: `sk-ant-api03-...` (your actual key)
7. Click "Deploy"
8. Copy the deployment URL (e.g., `https://mybudget-backend.vercel.app`)
9. Update the HTML file to use this URL

## API Endpoint

**POST** `/api/parse-file`

Request body:
```json
{
  "content": "bank statement text or CSV content",
  "country": "Brazil" or "Israel"
}
```

Response:
```json
{
  "success": true,
  "transactions": [
    {
      "date": "2026-01-15",
      "description": "Store name",
      "amount": -50.00,
      "category": "Groceries"
    }
  ]
}
```
