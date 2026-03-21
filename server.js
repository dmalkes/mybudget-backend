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

// Try to extract JSON array from Claude response (handles code blocks too)
function extractJSON(text) {
  // Try to find JSON inside code blocks first: ```json [...] ```
  const codeBlockMatch = text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
  if (codeBlockMatch) {
    try { return JSON.parse(codeBlockMatch[1]); } catch (e) {}
  }

  // Try to find a raw JSON array
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try { return JSON.parse(arrayMatch[0]); } catch (e) {}
  }

  return null;
}

// Call Claude with a prompt
async function callClaude(prompt) {
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
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || 'Claude API error');
  }

  const data = await response.json();
  return data.content[0].text;
}

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

    const isBrazil = country === 'Brazil';

    // Truncate content to avoid token limits (keep first 3000 chars)
    const sample = content.slice(0, 3000);

    // First attempt: strict JSON prompt
    const prompt1 = `You are a financial data parser. Extract ALL transactions from this bank statement.

IMPORTANT: Respond with ONLY a valid JSON array. No explanation, no markdown, just the JSON array.

Format: [{"date":"YYYY-MM-DD","description":"Merchant name","amount":number,"category":"Category"}]
- amount: negative for expenses, positive for income
- date: always YYYY-MM-DD format
${isBrazil ? '- Brazilian format: DD/MM/YYYY dates, comma decimals (1.234,50 = 1234.50)' : '- Israeli format: DD.MM.YYYY dates, period decimals'}
- category: one of: Food & Dining, Groceries, Transportation, Shopping, Entertainment, Health & Medical, Utilities, Subscriptions & Software, Housing, Income, Other

Bank statement:
${sample}

JSON array only:`;

    let result = await callClaude(prompt1);
    let transactions = extractJSON(result);

    // Second attempt: if first failed, try with a more permissive prompt
    if (!transactions) {
      console.log('First parse failed, trying fallback prompt. Claude said:', result.slice(0, 200));

      const prompt2 = `Look at this bank statement text and list every transaction you can find as a JSON array.

Each transaction: {"date":"YYYY-MM-DD","description":"string","amount":number,"category":"string"}

If you can't determine the date, use "2026-01-01". If you can't determine amount sign, make expenses negative.
Return ONLY the JSON array, nothing else.

Text:
${sample}`;

      result = await callClaude(prompt2);
      transactions = extractJSON(result);
    }

    if (!transactions || transactions.length === 0) {
      console.log('Both parse attempts failed. Last Claude response:', result.slice(0, 300));
      return res.status(400).json({
        error: 'Could not extract transaction data. Make sure the file contains readable transaction data (not a scanned image).',
      });
    }

    res.json({ success: true, transactions });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message || 'Server error' });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MyBudget backend running on port ${PORT}`);
});
