const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const path = require('path');

const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.text({ limit: '50mb' }));

// Serve the frontend app
app.use(express.static(path.join(__dirname, 'public')));

// Get API key from environment variable
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY && process.env.NODE_ENV !== 'production') {
  console.warn('Warning: ANTHROPIC_API_KEY not set');
}

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'MyBudget backend running' });
});

// Try to extract JSON array from Claude response (handles code blocks + truncated responses)
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

  // Salvage truncated array: find all complete {...} objects even if array is cut off
  // This handles the case where max_tokens is hit mid-array
  const start = text.indexOf('[');
  if (start !== -1) {
    const chunk = text.slice(start);
    const objects = [];
    let depth = 0, inStr = false, escape = false, objStart = -1;
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      if (escape) { escape = false; continue; }
      if (c === '\\' && inStr) { escape = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') { if (depth++ === 0) objStart = i; }
      else if (c === '}') {
        if (--depth === 0 && objStart !== -1) {
          try { objects.push(JSON.parse(chunk.slice(objStart, i + 1))); } catch (e) {}
          objStart = -1;
        }
      }
    }
    if (objects.length > 0) return objects;
  }

  return null;
}

// Deterministic post-processing for Hebrew bank transactions
// Runs AFTER Claude parses — overrides categories for known Hebrew patterns
function hebrewPostProcess(transactions) {
  return transactions.map(t => {
    const d = t.orig || t.originalDescription || t.description || '';
    const isCredit = t.amount > 0;

    // Credit card companies → Transfers (geresh ׳ and apostrophe ' both covered by .)
    if (/ישראכרט|אלבר קרדיט|דיינרס קלוב|ויזה כאל|כרטיסי אשראי|מקס אי.טי|כאל/.test(d))
      return { ...t, category: 'Transfers' };

    // Loan payments → Loans & Debt
    if (/הו.ק.*הלוו?א|הלוואה קרן|הלוואה ריבית|הלו.*ריבית|הלו.*קרן/.test(d))
      return { ...t, category: 'Loans & Debt' };

    // Bank cheques and confirmed mobile/inter-account transfers
    // NOTE: generic "העברה" intentionally excluded here — employer salary deposits
    // also appear as "העברה - [Company Name]" and must stay as Income
    if (/שיק בנקאי|רכישת שיק|ביטול שיק|העב.? לאחר/.test(d))
      return { ...t, category: isCredit ? 'Refunds & Credits' : 'Transfers' };

    // Salary / payroll credits → Income (any positive credit with payroll-related keywords)
    if (isCredit && /משכורת|שכר עבודה|שכר|פיצוי|בונוס|תגמול|מקדמה.*שכר|שכר.*מקדמה/.test(d))
      return { ...t, category: 'Income' };

    // Papaya Global (payroll platform) — positive=salary in, negative=payroll out
    if (/פאפאיה/.test(d))
      return { ...t, category: isCredit ? 'Income' : 'Transfers' };

    // Bank HaPoalim RTL column-reversal fix:
    // In this bank's PDF, employer direct payments (salary/bonus/reimbursement) appear
    // in the חובה (debit) column due to RTL text extraction — but the balance INCREASES,
    // proving they are credits. We detect known employer names and correct the sign + category.
    // Pattern: company name ending in בע"מ (Ltd.) that is NOT a credit card / utility company.
    if (/ג.ייפרוג/.test(d))
      return { ...t, amount: Math.abs(t.amount), category: 'Income' };

    // Generic outgoing "העברה" (no salary keywords) → Transfers
    // Incoming "העברה" (positive) is left to AI classification — could be salary from employer
    if (/העברה/.test(d) && !isCredit)
      return { ...t, category: 'Transfers' };

    // ATM / cash withdrawals → Cash & ATM
    if (/משיכה|בנקט|כספומט/.test(d))
      return { ...t, category: 'Cash & ATM' };

    // Bank fees → Banking Fees
    if (/דירקט|עמלת? שיק|עמלת? חשבון|עמלת? מסגרת|עמלה|דמי כרטיס|דמי ניהול/.test(d))
      return { ...t, category: 'Banking Fees' };

    // Insurance → Insurance
    if (/מנורה מבטחים|הפניקס|מגדל ביטוח|כלל ביטוח|הראל ביטוח|מיטב דש|ביטוח/.test(d))
      return { ...t, category: 'Insurance' };

    // Subscriptions / recurring services
    if (/איתוראן/.test(d))
      return { ...t, category: 'Subscriptions & Software' };

    // Utilities — water authority, municipalities
    if (/איגוד ערים|מי|כנרת|מים|חשמל|גז|בזק/.test(d))
      return { ...t, category: 'Utilities' };

    // Travel — hotels, booking platforms
    if (/booking\.com|hotel|airbnb|אירביאנדבי/i.test(d))
      return { ...t, category: 'Travel' };

    // Government allowances → Income
    if (/קצבת ילדים|ביטוח לאומי|גמלה/.test(d))
      return { ...t, category: 'Income' };

    return t;
  });
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
      max_tokens: 8000,
      system: 'You are a precise financial data extractor. Respond ONLY with a valid JSON array. No explanations, no markdown code blocks, no text before or after the array. If a JSON array cannot be completed due to length, include as many complete transaction objects as possible.',
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
    const { content, country = 'Brazil', language = 'English' } = req.body;

    if (!content) {
      return res.status(400).json({ error: 'No content provided' });
    }

    if (!API_KEY) {
      return res.status(500).json({ error: 'API key not configured on server' });
    }

    const isBrazil = country === 'Brazil';
    const isIsrael = country === 'Israel';

    // Truncate content to avoid token limits (keep first 60000 chars — preprocessing already reduced noise)
    const sample = content.slice(0, 60000);

    const israelGuide = isIsrael ? `
- Israeli bank statement specifics:
  * Dates are DD/MM/YY or DD/MM/YYYY format
  * Amounts use period as decimal separator
  * IMPORTANT: Bank HaPoalim PDFs extract in RTL and the חובה/זכות columns are often
    reversed by PDF parsers. Use the running balance column to determine sign: if the
    balance INCREASES after a transaction, it is income (positive). Do not rely solely
    on which column (חובה/זכות) the amount appears in.
  * Negative amounts (debits) are expenses; positive amounts (credits) are income
  * Common Hebrew terms and their categories:
    - קצבת ילדים, ביטוח לאומי, גמלה, משכורת, פאפאיה גלובל = Income (salary/government payments)
    - Any positive credit from an employer or company name (tech companies, corporations, startups) = Income (salary/payroll) — even if the description also contains "העברה"
    - כרטיסי אשראי, ישראכרט, אלבר קרדיט, דיינרס קלוב, ויזה כאל, מקס, כאל, מקס אי טי = Transfers (credit card payments)
    - הו"ק הלוואה, הו"ק הלו', הלוואה קרן, הלוואה ריבית = Loans & Debt (loan payments)
    - העב' לאחר נייד, רכישת שיק בנקאי, ביטול שיק בנקאי, שיק בנקאי = Transfers (inter-account bank transfers)
    - "העברה" alone (without employer context) = Transfers; "העברה" FROM a company/employer = Income
    - משיכה, משיכה מבנקט, כספומט = Cash & ATM (ATM withdrawals)
    - דירקט, דירקט מצטבר, עמלה, עמלת שיק בנקאי, עמלת חשבון = Banking Fees
    - ארנונה = Utilities (municipal tax)
    - חשמל, גז, מים, בזק, הוט, פרטנר, סלקום, אורנג = Utilities
    - שופרסל, רמי לוי, ויקטורי, יינות ביתן, מגה, AM:PM = Groceries
    - מסעדה, קפה, בית קפה, מקדונלד, בורגר קינג, שווארמה = Food & Dining
    - בתי מרקחת, סופר פארם, ניאו פארם, מכבי, קופת חולים = Health & Medical
    - פז, סונול, דלק = Transportation (fuel)
    - רכבת ישראל, דן, אגד = Transportation
    - אמזון, עלי אקספרס, זארה, H&M = Shopping
    - נטפליקס, ספוטיפיי, אפל, גוגל = Subscriptions & Software
    - שכר דירה, ועד בית = Housing` : '';

    const brazilGuide = isBrazil ? '- Brazilian format: DD/MM/YYYY dates, comma decimals (1.234,50 = 1234.50)' : '';

    // First attempt: strict JSON prompt
    const prompt1 = `You are a financial data parser. Extract ALL transactions from this bank statement.

IMPORTANT: Respond with ONLY a valid JSON array. No explanation, no markdown, just the JSON array.

Format: [{"date":"YYYY-MM-DD","description":"Merchant","orig":"orig text (max 30 chars)","amount":number,"category":"Category"}]
- amount: negative for expenses, positive for income
- date: always YYYY-MM-DD format
- description: short merchant/payee name translated to ${language} (keep it concise, max 30 chars)
- orig: first 30 characters of the original text exactly as it appears in the statement
${brazilGuide}${israelGuide}
- category: one of: Food & Dining, Groceries, Transportation, Shopping, Entertainment, Health & Medical, Utilities, Subscriptions & Software, Travel, Education, Home & Garden, Personal Care, Insurance, Business Services, Loans & Debt, Housing, Transfers, Refunds & Credits, Income, Cash & ATM, Banking Fees, Other
- Refunds from a specific merchant should use the SAME category as that merchant type (e.g., refund from an airline → Travel, refund from restaurant → Food & Dining, refund from store → Shopping). Only use 'Refunds & Credits' for generic/unclear refunds with no identifiable merchant category.
- Use context clues to categorize even if the description is in Hebrew or another language

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

    // Apply deterministic Hebrew post-processing (overrides AI guesses for known patterns)
    if (isIsrael) {
      transactions = hebrewPostProcess(transactions);
    }

    res.json({ success: true, transactions });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message || 'Server error' });
  }
});

// Chat endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { message, systemPrompt } = req.body;
    if (!message) return res.status(400).json({ error: 'No message provided' });
    if (!API_KEY) return res.status(500).json({ error: 'API key not configured' });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: systemPrompt || 'You are a helpful personal finance assistant.',
        messages: [{ role: 'user', content: message }]
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || 'Claude API error');
    }

    const data = await response.json();
    res.json({ reply: data.content[0].text });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: error.message || 'Server error' });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MyBudget backend running on port ${PORT}`);
});
