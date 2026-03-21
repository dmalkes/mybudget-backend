const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.text({ limit: '50mb' }));

// Get API key from environment variable
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY && process.env.NODE_ENV !== 'production') {
  console.warn('Warning: ANTHROPIC_API_KEY not set');
}

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'MyBudget backend running' });
});

// Parse file endpoint
app.post('/api/parse-file', async (req, res) => {
  try {
    const { content, country = 'Brazil' } = req.body;

    if (!content) {
      return res.status(400).json({ error: 'No content provided' });
    }

    if (!API_KEY) {
      return res.status(500).json({ error: 'API key not configured on server' });
    }

    // Build the extraction prompt
    const isBrazil = country === 'Brazil';
    const prompt = `You are a financial data parser. Analyze this bank statement excerpt and extract ALL transactions.

Bank statement sample:
${content}

Rules:
${isBrazil ? '- Brazilian format: dates may be DD/MM/YYYY, decimals use comma (1.234,50)' : '- Israeli format: dates may be DD.MM.YYYY, decimals use period (1234.50)'}
- Extract: date (YYYY-MM-DD format), description, amount (positive=income, negative=expense)
- Infer category from merchant: food, groceries, utilities, transport, subscriptions, etc.
- Return JSON array: [{"date":"2026-01-15","description":"Merchant","amount":100,"category":"Category"}, ...]
- Include ALL rows that look like transactions`;

    // Call Claude API
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4000,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      })
    });

    if (!response.ok) {
      const error = await response.json();
      console.error('Claude API error:', error);
      return res.status(response.status).json({
        error: error.error?.message || 'Claude API error'
      });
    }

    const data = await response.json();
    const result = data.content[0].text;

    // Parse JSON from response
    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return res.status(400).json({
        error: 'Could not extract transaction data',
        raw: result
      });
    }

    const transactions = JSON.parse(jsonMatch[0]);
    res.json({ success: true, transactions });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      error: error.message || 'Server error'
    });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MyBudget backend running on port ${PORT}`);
});
