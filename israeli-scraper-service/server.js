const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { getIsraeliBanks, scrapeAccount } = require('israeli-bank-scrapers');

const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'israeli-bank-scraper' });
});

// GET /banks — List available Israeli banks
app.get('/banks', async (req, res) => {
  try {
    const banks = await getIsraeliBanks();

    const formattedBanks = banks.map(bank => ({
      id: bank.companyId,
      name: bank.companyName,
      logo: bank.logo || null
    }));

    res.json({ banks: formattedBanks });
  } catch (error) {
    console.error('Error fetching Israeli banks:', error);
    res.status(500).json({ error: 'Failed to fetch bank list', details: error.message });
  }
});

// POST /scrape — Scrape transactions from Israeli bank
// Body: { bankId, username, password }
app.post('/scrape', async (req, res) => {
  try {
    const { bankId, username, password } = req.body;

    if (!bankId || !username || !password) {
      return res.status(400).json({
        error: 'Missing required fields: bankId, username, password'
      });
    }

    console.log(`[${new Date().toISOString()}] Scraping bank: ${bankId}`);

    // Scrape transactions from the Israeli bank
    const result = await scrapeAccount({
      companyId: bankId,
      username,
      password
    });

    if (!result.success) {
      console.error(`Scrape failed for ${bankId}:`, result.errorMessage);
      return res.status(400).json({
        error: 'Failed to login or scrape transactions',
        details: result.errorMessage
      });
    }

    // Normalize transactions to standard format
    const normalized = normalizeTransactions(result.accounts || []);

    console.log(`[${new Date().toISOString()}] Scraped ${normalized.length} transactions from ${bankId}`);

    res.json({
      success: true,
      accounts: (result.accounts || []).map(acc => ({
        id: acc.accountNumber,
        name: acc.accountName || acc.accountNumber,
        type: acc.accountType,
        balance: acc.balance
      })),
      transactions: normalized,
      transactionCount: normalized.length
    });

  } catch (error) {
    console.error('Scraper error:', error);
    res.status(500).json({
      error: 'Scraping failed',
      details: error.message
    });
  }
});

// Helper: Normalize Israeli bank transactions to standard format
function normalizeTransactions(accounts) {
  const normalized = [];

  for (const account of accounts || []) {
    for (const transaction of account.txns || []) {
      const category = classifyTransaction(transaction);

      normalized.push({
        date: transaction.date ? new Date(transaction.date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
        description: transaction.description || transaction.memo || 'Transaction',
        originalDescription: transaction.description || transaction.memo || 'Transaction',
        amount: transaction.amount || 0,
        category: category,
        merchant: extractMerchant(transaction.description || ''),
        accountId: account.accountNumber,
        accountName: account.accountName,
        source: 'israeli_bank_scraper',
        transactionId: `${account.accountNumber}_${transaction.date}_${transaction.amount}`
      });
    }
  }

  return normalized;
}

// Helper: Classify transaction by category (Hebrew-aware)
function classifyTransaction(txn) {
  const desc = (txn.description || txn.memo || '').toLowerCase();

  // Supermarkets
  if (/סופרמרקט|קונים|רמי לוי|תנובה|מחסן|סופר/i.test(desc)) return 'Groceries';

  // Utilities
  if (/חשמל|גז|מים|חשכ"ל|דלק|בנזין|דלק|חוקי חשמל/i.test(desc)) return 'Utilities';

  // Transportation
  if (/תחבורה|אוטובוס|מונית|דלק|בנזין|חניון|רכבת|אגד/i.test(desc)) return 'Transportation';

  // Shopping
  if (/קניה|חנות|שופינג|בגדים|נעליים|אפנה/i.test(desc)) return 'Shopping';

  // Healthcare
  if (/בית חולים|קליניקה|רופא|תרופה|בריאות|פרמציה/i.test(desc)) return 'Health & Medical';

  // Education
  if (/בית ספר|אוניברסיטה|קורס|חינוך|ספרים/i.test(desc)) return 'Education';

  // Entertainment
  if (/קולנוע|בידור|קונסרט|ספורט|חדר כושר/i.test(desc)) return 'Entertainment';

  return 'Other';
}

// Helper: Extract merchant name from description
function extractMerchant(description) {
  const parts = description.split(/[-–—]/);
  return (parts[0] || description).trim();
}

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Israeli bank scraper service running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
