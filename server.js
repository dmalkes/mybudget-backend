const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const rateLimit = require('express-rate-limit');
const { PluggyClient } = require('pluggy-sdk');

const path = require('path');

const app = express();

// Pluggy client — uses CLIENT_ID + CLIENT_SECRET from env
// In production, ensure these are set in Vercel environment variables
let pluggyClient = null;
try {
  if (process.env.PLUGGY_CLIENT_ID && process.env.PLUGGY_CLIENT_SECRET) {
    pluggyClient = new PluggyClient({
      clientId: process.env.PLUGGY_CLIENT_ID,
      clientSecret: process.env.PLUGGY_CLIENT_SECRET,
    });
    console.log('Pluggy client initialized successfully');
  } else {
    console.warn('Pluggy credentials not found in environment variables');
  }
} catch (err) {
  console.error('Failed to initialize Pluggy client:', err.message);
}

// Middleware
app.use(cors()); // open — app is a local HTML file, CORS restriction would break file:// users
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.text({ limit: '10mb' }));

// Rate limiting — prevents API credit abuse without blocking any legitimate user
// 20 parse requests / hour per IP is generous for any real use
const parseLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please wait before uploading again.' },
});
const chatLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please try again later.' },
});

// Serve the frontend app — no-store on HTML to prevent CDN edge caching stale JS
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

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

// Deterministic post-processing for Brazilian bank/credit-card transactions
// Runs AFTER Claude parses — overrides categories for known Brazilian patterns
function brazilPostProcess(transactions) {
  return transactions.map(t => {
    const raw = t.orig || t.originalDescription || t.description || '';
    // Normalize: lowercase + strip diacritics (so "PÃO DE AÇÚCAR" = "pao de acucar")
    // Also replace * with space (Nubank uses NETFLIX*BR, SPOTIFY*12345 etc.)
    const d = raw.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\*/g, ' ');
    const isCredit = t.amount > 0;

    // ── TRANSFERS (bill payments — must run first, before merchant checks) ──
    if (/pagamento\s*(fatura|cartao|agendado|debito|automatico)|pag\s*fatura|pgto\s*fatura/.test(d))
      return { ...t, category: 'Transfers' };

    // ── INCOME ────────────────────────────────────────────────────────────
    if (isCredit && /salario|salari|folha|payroll|vencimento|remuneracao|rendimento\s*salario/.test(d))
      return { ...t, category: 'Income' };
    if (isCredit && /\binss\b|previdencia|bolsa\s*famil|auxilio|beneficio|fgts|rescisao/.test(d))
      return { ...t, category: 'Income' };

    // ── CASH & ATM ────────────────────────────────────────────────────────
    if (/saque|\bsaq\b|caixa\s*eletronico|\batm\b/.test(d))
      return { ...t, category: 'Cash & ATM' };

    // ── BANKING FEES ──────────────────────────────────────────────────────
    if (/tarifa|anuidade|taxa\s*(manutencao|servico)|iof|juros\s*rotativo|encargo\s*financ|\bmora\b/.test(d))
      return { ...t, category: 'Banking Fees' };

    // ── LOANS & DEBT ──────────────────────────────────────────────────────
    if (/parcela\s*(emprestimo|financiamento|credito)|emprestimo|financiamento|consignado/.test(d))
      return { ...t, category: 'Loans & Debt' };

    // ── FOOD DELIVERY (before PIX fallback — iFood etc. are often paid via PIX) ──
    if (/ifood|rappi|uber\s*eats|ubereats|james\s*delivery|aiqfome|ze\s*delivery|zedeli|goomer/.test(d))
      return { ...t, category: 'Food & Dining' };

    // ── TRANSPORTATION (before PIX fallback — tolls, transit, ride-hail paid via PIX) ──
    // Ride hailing
    if (/\buber\b(?!\s*eats)|\b99\b|99app|cabify|indriver|\bbuser\b|blablacar/.test(d))
      return { ...t, category: 'Transportation' };
    // Fuel
    if (/ipiranga|\bshell\b|br\s*distribuidora|petrobras\s*(dist|br)\b|raizen|\besso\b|vibra\s*energia|\bale\b.*combust|\bgraal\b|\bposto\b|combustivel/.test(d))
      return { ...t, category: 'Transportation' };
    // Public transit
    if (/bilhete\s*unico|metro\s*(sp|rj)?\b|\bcptm\b|sptrans|supervia|metrorio|\bbrt\b|trilhos\b/.test(d))
      return { ...t, category: 'Transportation' };
    // Bus companies & intercity
    if (/gontijo|itapemirim|\butil\b.*tur|\bcometa\b|expresso\s*do\s*sul|reunidas|viacao|empresa\s*de\s*onibus|emp\s*onibus|\bonibus\b|rodoviaria/.test(d))
      return { ...t, category: 'Transportation' };
    // Tolls & tags
    if (/autoban|\bccr\b|ecopistas|ecovias|sem\s*parar|conectcar|veloe|pedagio|portagem/.test(d))
      return { ...t, category: 'Transportation' };
    // Car rental & parking
    if (/localiza|\bmovida\b|\bunidas\b|hertz|\bavis\b|estapar|multipark|indigo\s*park|estacionamento/.test(d))
      return { ...t, category: 'Transportation' };
    // DETRAN / licensing
    if (/\bdetran\b|licenciamento|dpvat|ipva/.test(d))
      return { ...t, category: 'Transportation' };

    // ── PIX / TED / DOC fallback → Transfers (AFTER all merchant checks above) ──
    if (!isCredit && /\bpix\b|\bted\b|\bdoc\b/.test(d))
      return { ...t, category: 'Transfers' };

    // ── GROCERIES ─────────────────────────────────────────────────────────
    if (/carrefour|pao\s*de\s*acucar|\bgpa\b|companhia\s*brasileira\s*de\s*dis/.test(d))
      return { ...t, category: 'Groceries' };
    if (/assai|atacadao|prezunic|guanabara|hortifruti/.test(d))
      return { ...t, category: 'Groceries' };
    // \bextra\b but NOT extra eletro
    if (/\bextra\b/.test(d) && !/extra\s*eletro/.test(d))
      return { ...t, category: 'Groceries' };
    if (/cencosud|gbarbosa|\bbretas\b|mercantil\s*rodrigues/.test(d))
      return { ...t, category: 'Groceries' };
    if (/savegnago|\bsonda\b|zaffari|sendas|supernosso|super\s*pao|angeloni|bistek|giassi/.test(d))
      return { ...t, category: 'Groceries' };
    if (/fort\s*atacadista|grupo\s*mateus|bh\s*supermercados|walmart|\bsam\s*s?\s*club\b/.test(d))
      return { ...t, category: 'Groceries' };
    if (/mundo\s*verde|natural\s*da\s*terra|emporio/.test(d))
      return { ...t, category: 'Groceries' };
    if (/supermercado|hipermercado|atacarejo/.test(d))
      return { ...t, category: 'Groceries' };
    // Generic "mercado" but NOT mercado livre / mercado pago
    if (/\bmercado\b/.test(d) && !/mercado\s*(livre|pago)/.test(d))
      return { ...t, category: 'Groceries' };

    // ── UTILITIES ─────────────────────────────────────────────────────────
    // Electricity (all Brazilian state distributors)
    if (/\benel\b|cemig|\bcpfl\b|energisa|coelba|elektro|\blight\b|eletropaulo/.test(d))
      return { ...t, category: 'Utilities' };
    if (/celesc|\brge\b|\bcemar\b|equatorial\s*(ma|go|pa)|cosern|\bceron\b|amazonas\s*energia/.test(d))
      return { ...t, category: 'Utilities' };
    if (/\bceee\b|\bceb\s*dist|\bcelpa\b|\bceal\b|\bcelpe\b|\bdmed\b|coelce/.test(d))
      return { ...t, category: 'Utilities' };
    // Water & sanitation
    if (/sabesp|copasa|caesb|sanepar|cagece|embasa|\bcasan\b|caern|caema|\bdeso\b|agespisa|compesa|cosama|cedae|sanesul|saneago/.test(d))
      return { ...t, category: 'Utilities' };
    // Telecom — mobile
    if (/\bvivo\b|telefonica|\btim\b|\bclaro\b|\boi\s*(movel|celular|fibra|internet)?\b|nextel|algar|sercomtel|brisanet/.test(d))
      return { ...t, category: 'Utilities' };
    // Telecom — internet/cable (\bnet\b only with qualifier to avoid false positives)
    if (/\bnet\s*(virtua|internet|combo)\b|\bsky\b|claro\s*(tv|net|internet)|vivo\s*(fibra|internet)|oi\s*fibra|unifique/.test(d))
      return { ...t, category: 'Utilities' };
    // Piped/cylinder gas
    if (/comgas|copergas|gasmig|bahiagas|scgas|sulgas|ultragaz|supergasbras|liquigas/.test(d))
      return { ...t, category: 'Utilities' };

    // ── HEALTH & MEDICAL ──────────────────────────────────────────────────
    // Pharmacies (specific chains first)
    if (/droga\s*raia|drogaria\s*raia|drogasil|ultrafarma|pacheco|pague\s*menos|nossa\s*farmacia|panvel|nissei|venancio/.test(d))
      return { ...t, category: 'Health & Medical' };
    if (/droga\s*sao\s*paulo|dsaopaulo|onofre|drogao/.test(d))
      return { ...t, category: 'Health & Medical' };
    // Generic pharmacy
    if (/farmacia|drogaria/.test(d))
      return { ...t, category: 'Health & Medical' };
    // Health insurance (plano de saúde)
    if (/unimed|hapvida|\bamil\b|sulamerica\s*saude|bradesco\s*saude|notre\s*dame|notredame|omint|\bgndi\b|prevent\s*senior|\bgeap\b|\bcassi\b|plano\s*saude/.test(d))
      return { ...t, category: 'Health & Medical' };
    // Labs & hospitals
    if (/fleury|\bdasa\b|pardini|lavoisier|einstein|sirio\s*libanes|mater\s*dei/.test(d))
      return { ...t, category: 'Health & Medical' };
    if (/laboratorio|\blab\b(?=\s)|clinica|hospital|consultorio|dentista|odonto|clinipam/.test(d))
      return { ...t, category: 'Health & Medical' };

    // ── INSURANCE (after health — sulamerica saude → Health, sulamerica alone → Insurance) ──
    if (/porto\s*seguro|bradesco\s*seg(?!\s*saude)|tokio\s*marine|zurich|allianz|mapfre|azul\s*seg|itau\s*seg|xp\s*seguros|\bsura\b|bbseg|bb\s*seguridade/.test(d))
      return { ...t, category: 'Insurance' };
    if (/sulamerica\b(?!\s*saude)|sul\s*america\b(?!\s*saude)/.test(d))
      return { ...t, category: 'Insurance' };
    if (/\bseguro\b(?!\s*saude)/.test(d) && !isCredit)
      return { ...t, category: 'Insurance' };

    // ── SUBSCRIPTIONS & SOFTWARE ──────────────────────────────────────────
    // Video streaming
    if (/netflix|disney\s*\+?|disney\s*plus|hbo\s*max|star\s*\+?|star\s*plus|globoplay|paramount|crunchyroll|mubi/.test(d))
      return { ...t, category: 'Subscriptions & Software' };
    // Music
    if (/spotify|deezer|apple\s*music|\btidal\b/.test(d))
      return { ...t, category: 'Subscriptions & Software' };
    // Cloud & productivity
    if (/google\s*(one|play)|youtube\s*pre|apple\s*(one|tv|arcade)|icloud|microsoft|\bmsft\b|adobe|dropbox|github|notion|chatgpt|openai|\bcanva\b|\bzoom\b/.test(d))
      return { ...t, category: 'Subscriptions & Software' };
    // Games
    if (/\bsteam\b|xbox|playstation|\bpsn\b|nintendo|riot\s*games?|blizzard|\bea\s*games\b|nuuvem/.test(d))
      return { ...t, category: 'Subscriptions & Software' };
    // News
    if (/folha\s*digital|estadao|globo\s*\+?|\buol\b/.test(d))
      return { ...t, category: 'Subscriptions & Software' };

    // ── SHOPPING ──────────────────────────────────────────────────────────
    // Department / e-commerce
    if (/magalu|magazine\s*luiza|americanas|\bb2w\b|casas\s*bahia|via\s*varejo|ponto\s*frio|pontofrio/.test(d))
      return { ...t, category: 'Shopping' };
    if (/mercado\s*(livre|pago)|mercadolivre|mercadopago|amazon|\bamzn\b|shopee|aliexpress|\bshein\b|submarino/.test(d))
      return { ...t, category: 'Shopping' };
    // Fashion & clothing
    if (/\brenner\b|riachuelo|c\s*&\s*a\b|\bleader\b|marisa|\bzara\b|hering|arezzo|dafiti|netshoes|centauro/.test(d))
      return { ...t, category: 'Shopping' };
    // Electronics
    if (/fast\s*shop|kabum|terabyte|samsung/.test(d))
      return { ...t, category: 'Shopping' };
    // Home & garden
    if (/leroy\s*merlin|telhanorte|sodimac|cassol|\betna\b|tok\s*stok|mobly|westwing|madeira\s*madeira/.test(d))
      return { ...t, category: 'Shopping' };
    // Pet stores
    if (/\bpetz\b|cobasi|petlove|pet\s*center/.test(d))
      return { ...t, category: 'Shopping' };
    // Beauty / cosmetics
    if (/\bnatura\b|boticario|sephora|quem\s*disse|berenice|eudora|granado/.test(d))
      return { ...t, category: 'Shopping' };

    // ── FOOD & DINING (fast food & restaurants after delivery apps) ────────
    if (/mcdonalds?|burger\s*king|\bbobs?\b|giraffas|habib|outback|spoleto|coco\s*bambu/.test(d))
      return { ...t, category: 'Food & Dining' };
    if (/subway|popeyes|\bkfc\b|jeronimo|frango\s*assado|china\s*in\s*box|pizza\s*hut|dominos?/.test(d))
      return { ...t, category: 'Food & Dining' };
    if (/madero|vivenda\s*do\s*camar|paris\s*6|starbucks|dunkin|nespresso|cafe\s*do\s*ponto/.test(d))
      return { ...t, category: 'Food & Dining' };
    if (/restaurante|pizzaria|churrascaria|lanchonete|padaria|confeitaria|sushi|boteco|cervejaria/.test(d))
      return { ...t, category: 'Food & Dining' };

    // ── EDUCATION ─────────────────────────────────────────────────────────
    if (/estacio|anhanguera|kroton|cogna|\bunip\b|uninove|mackenzie|\bfgv\b|insper|\bpuc\b/.test(d))
      return { ...t, category: 'Education' };
    if (/\balura\b|rocketseat|coursera|udemy|hotmart|kiwify|eduzz|duolingo|babbel/.test(d))
      return { ...t, category: 'Education' };
    if (/colegio|\bescola\b|creche|material\s*escolar/.test(d))
      return { ...t, category: 'Education' };

    // ── ENTERTAINMENT ─────────────────────────────────────────────────────
    if (/cinemark|cinepolis|kinoplex|\buci\s*(cinema)?\b|cinesystem|cinemais/.test(d))
      return { ...t, category: 'Entertainment' };
    if (/sympla|eventbrite|ingresso\s*(rapido|\.com)|ticket360|blueticket|bilheteria\s*digital/.test(d))
      return { ...t, category: 'Entertainment' };

    // ── PERSONAL CARE ─────────────────────────────────────────────────────
    if (/smart\s*fit|bluefit|bodytech|academia|crossfit|pilates/.test(d))
      return { ...t, category: 'Personal Care' };
    if (/barbearia|salao\s*de\s*beleza|barba\s*e\s*cabelo/.test(d))
      return { ...t, category: 'Personal Care' };

    // ── HOUSING ───────────────────────────────────────────────────────────
    if (/aluguel|condominio|\biptu\b|\bitbi\b|administradora\s*im(oveis|ovel)|taxa\s*cond/.test(d))
      return { ...t, category: 'Housing' };
    if (/quinto\s*andar|quintoandar|\bmrv\b|cyrela|helbor/.test(d))
      return { ...t, category: 'Housing' };

    return t; // no match — leave AI classification as-is
  });
}

// Deterministic post-processing for Dutch bank transactions
// Runs AFTER Claude parses — overrides categories for known Dutch patterns
function dutchPostProcess(transactions) {
  return transactions.map(t => {
    const d = (t.orig || t.originalDescription || t.description || '').toLowerCase();
    const isCredit = t.amount > 0;

    // Salary / payroll credits → Income
    if (isCredit && /salaris|loon|vakantiegeld|dertiende maand|bonus|netto loon/.test(d))
      return { ...t, category: 'Income' };

    // Government benefits → Income
    if (isCredit && /uwv|svb|kinderbijslag|zorgtoeslag|huurtoeslag|belastingdienst.*terug|toeslagen/.test(d))
      return { ...t, category: 'Income' };

    // iDEAL / bank transfers → Transfers
    if (/ideal|overboeking|overschrijving/.test(d) && !isCredit)
      return { ...t, category: 'Transfers' };

    // Incasso (direct debit) — leave to AI, but fix common patterns below

    // Rent / mortgage → Housing
    if (/huur|hypotheek|vve bijdrage|servicekosten woning/.test(d))
      return { ...t, category: 'Housing' };

    // Utilities — energy, water, internet, phone
    if (/eneco|vattenfall|nuon|essent|greenchoice|budget energie|oxxio|energiedirect/.test(d))
      return { ...t, category: 'Utilities' };
    if (/vitens|evides|dunea|waternet|waterleidingbedrijf/.test(d))
      return { ...t, category: 'Utilities' };
    if (/ziggo|kpn|t-mobile thuis|odido thuis|xs4all/.test(d))
      return { ...t, category: 'Utilities' };

    // Mobile phone → Utilities
    if (/t-mobile|odido|vodafone|ben mobiel|simyo|hollandsnieuwe/.test(d))
      return { ...t, category: 'Utilities' };

    // Health insurance → Insurance
    if (/zorgverzekering|menzis|cz groep|vgz|achmea|zilveren kruis|ditzo zorg|interpolis zorg/.test(d))
      return { ...t, category: 'Insurance' };

    // Other insurance → Insurance
    if (/verzekering|centraal beheer|nationale nederlanden|aegon|allianz/.test(d))
      return { ...t, category: 'Insurance' };

    // Groceries → Groceries
    if (/albert heijn|jumbo|lidl|aldi|plus supermarkt|dirk|coop supermarkt|picnic|hoogvliet/.test(d))
      return { ...t, category: 'Groceries' };

    // Fuel → Transportation
    if (/shell|bp |texaco|tango|tinq|esso|tamoil/.test(d))
      return { ...t, category: 'Transportation' };

    // Public transport → Transportation
    if (/ns |ov-chipkaart|gvb|ret |htm |connexxion|arriva|transdev|qbuzz/.test(d))
      return { ...t, category: 'Transportation' };

    // Ride sharing / taxi → Transportation
    if (/uber|bolt taxi|coolblue taxi/.test(d))
      return { ...t, category: 'Transportation' };

    // Municipal tax → Utilities
    if (/gemeente|gemeentebelastingen|waterschapsbelasting/.test(d))
      return { ...t, category: 'Utilities' };

    // Bank fees → Banking Fees
    if (/bunq|ing bank kosten|rabo kosten|abnamro kosten|servicekosten rekening|betaalrekening kosten/.test(d))
      return { ...t, category: 'Banking Fees' };

    // ATM withdrawals → Cash & ATM
    if (/geldautomaat|geldopname|atm/.test(d))
      return { ...t, category: 'Cash & ATM' };

    // Subscriptions → Subscriptions & Software
    if (/netflix|spotify|disney\+|videoland|npo start|amazon prime|apple.*subscr|google.*subscr|adobe/.test(d))
      return { ...t, category: 'Subscriptions & Software' };

    return t;
  });
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

const VALID_COUNTRIES = ['Brazil', 'Israel', 'Netherlands'];

// Parse file endpoint
app.post('/api/parse-file', parseLimiter, async (req, res) => {
  try {
    let { content, country = 'Brazil', language = 'English' } = req.body;

    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'No content provided' });
    }
    if (!VALID_COUNTRIES.includes(country)) country = 'Brazil';
    if (!['English', 'Portuguese', 'Hebrew'].includes(language)) language = 'English';

    if (!API_KEY) {
      return res.status(500).json({ error: 'API key not configured on server' });
    }

    const isBrazil      = country === 'Brazil';
    const isIsrael      = country === 'Israel';
    const isNetherlands = country === 'Netherlands';

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

    const brazilGuide = isBrazil ? `
- Brazilian bank/credit-card format:
  * Dates: DD/MM/YYYY or DD/MM (no year — infer year from statement header or surrounding context; if unknown use current year)
  * Amounts: comma decimal, period thousands (1.234,50 = 1234.50) — always output as a plain number
  * PAGAMENTO FATURA / PAGAMENTO CARTÃO / PGTO FATURA = credit card bill payment → category "Transfers", positive amount
  * PIX, TED, DOC = bank transfers → category "Transfers" (unless it is clearly a salary deposit)
  * SAQUE / Caixa Eletrônico = ATM withdrawal → category "Cash & ATM"
  * Tarifa, Anuidade, IOF, Juros Rotativos = bank fees → category "Banking Fees"
  * Common Brazilian merchants:
    - iFood, Rappi, Uber Eats, James Delivery = Food & Dining
    - Uber, 99, Cabify = Transportation
    - Ipiranga, Shell, BR Distribuidora = Transportation (fuel)
    - Carrefour, Extra, Assaí, Atacadão, Pão de Açúcar = Groceries
    - Mercado Livre, Amazon, Shopee, Americanas, Magazine Luiza = Shopping
    - Netflix, Spotify, Disney+, Globoplay, Amazon Prime = Subscriptions & Software
    - Vivo, TIM, Claro, Oi, NET = Utilities
    - ENEL, CEMIG, CPFL, SABESP = Utilities
    - Drogaria, Farmácia, Droga Raia, Drogasil = Health & Medical` : '';

    const netherlandsGuide = isNetherlands ? `
- Dutch bank statement specifics:
  * Dates are DD-MM-YYYY format (e.g. 15-03-2026)
  * Amounts use period as decimal separator; thousands separator is a period too (e.g. 1.234,56 → read as 1234.56)
  * "Af" or "D" (Debet/Debit) = outgoing expense → negative amount
  * "Bij" or "C" (Credit) = incoming money → positive amount
  * iDEAL = Dutch online bank transfer (usually an expense)
  * Incasso = direct debit (recurring expense)
  * Overboeking = bank transfer between accounts
  * Bijschrijving = credit / money received
  * Afschrijving = debit / money paid
  * Common Dutch merchants and categories:
    - Albert Heijn, Jumbo, Lidl, Aldi, Plus, Dirk, Coop = Groceries
    - NS, GVB, RET, HTM, Connexxion, OV-chipkaart = Transportation (public transit)
    - Shell, BP, Texaco, Tango, Tinq = Transportation (fuel)
    - Ziggo, KPN, T-Mobile, Odido = Utilities (internet/phone)
    - Eneco, Vattenfall, Nuon, Essent, Greenchoice = Utilities (energy)
    - Vitens, Evides, Dunea, Waternet = Utilities (water)
    - Menzis, CZ, VGZ, Achmea, Zilveren Kruis = Insurance (health)
    - Gemeente, Waterschapsbelasting = Utilities (municipal/water taxes)
    - Netflix, Spotify, Disney+, Videoland = Subscriptions & Software
    - Bol.com, Zalando, H&M, Zara, HEMA, Primark = Shopping
    - Salaris, Loon, Vakantiegeld = Income (salary)
    - Huur, Hypotheek = Housing (rent/mortgage)
    - UWV, SVB, Kinderbijslag, Zorgtoeslag, Belastingdienst (credit) = Income (government benefit)
    - Huisarts, Tandarts, Apotheek, Kruidvat, Etos = Health & Medical` : '';

    // First attempt: strict JSON prompt
    const prompt1 = `You are a financial data parser. Extract ALL transactions from this bank statement.

IMPORTANT: Respond with ONLY a valid JSON array. No explanation, no markdown, just the JSON array.

Format: [{"date":"YYYY-MM-DD","description":"Merchant","orig":"orig text (max 30 chars)","amount":number,"category":"Category"}]
- amount: negative for expenses, positive for income
- date: always YYYY-MM-DD format
- description: short merchant/payee name translated to ${language} (keep it concise, max 30 chars)
- orig: first 30 characters of the original text exactly as it appears in the statement
${brazilGuide}${israelGuide}${netherlandsGuide}
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
      console.log('[parse] First attempt failed — trying fallback prompt');

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
      console.log('[parse] Both attempts failed — no transactions extracted');
      return res.status(400).json({
        error: 'Could not extract transaction data. Make sure the file contains readable transaction data (not a scanned image).',
      });
    }

    // Apply deterministic post-processing (overrides AI guesses for known patterns)
    if (isBrazil)      transactions = brazilPostProcess(transactions);
    if (isIsrael)      transactions = hebrewPostProcess(transactions);
    if (isNetherlands) transactions = dutchPostProcess(transactions);

    res.json({ success: true, transactions });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message || 'Server error' });
  }
});

// Chat endpoint
app.post('/api/chat', chatLimiter, async (req, res) => {
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

// ────────────────────────────────────────────────────────────────────────────
// Pluggy Open Finance Integration
// ────────────────────────────────────────────────────────────────────────────

// POST /api/pluggy/connect-token — Generate a short-lived widget token
// Frontend calls this to get a connectToken for the Pluggy widget
app.post('/api/pluggy/connect-token', async (req, res) => {
  if (!pluggyClient) {
    return res.status(503).json({
      error: 'Pluggy not configured. Set PLUGGY_CLIENT_ID and PLUGGY_CLIENT_SECRET in environment.'
    });
  }

  try {
    const { clientUserId, itemId } = req.body;
    // clientUserId should be a stable user ID from your app
    // itemId is optional — if provided, generate a token for reconnecting that Item

    console.log('Creating Pluggy token for user:', clientUserId || 'anonymous');
    const tokenResponse = await pluggyClient.createConnectToken({
      clientUserId: clientUserId || 'anonymous-' + Date.now(),
      itemId // optional: reconnect to existing item
    });

    console.log('Token created successfully:', tokenResponse);
    res.json({ connectToken: tokenResponse.accessToken });
  } catch (error) {
    console.error('Pluggy connect-token error details:', error.message, error.stack);
    res.status(500).json({
      error: 'Failed to generate connect token',
      details: error.message
    });
  }
});

// POST /api/pluggy/webhook — Receive item creation/update events from Pluggy
// Pluggy calls this when a user connects a bank account
app.post('/api/pluggy/webhook', async (req, res) => {
  try {
    const { event, eventId, clientUserId, itemId, error } = req.body;

    console.log(`[Pluggy Webhook] Event: ${event}, ItemID: ${itemId}, ClientUserID: ${clientUserId}`);

    if (event === 'item/created' || event === 'item/updated') {
      // Item successfully connected — fetch its details and store in your DB
      // For now, just acknowledge. In production, store the itemId against the user.
      console.log(`Item ${itemId} for user ${clientUserId} is ready`);
    }

    if (event === 'item/error') {
      console.error(`Item ${itemId} error:`, error);
    }

    // Always return 200 to confirm webhook receipt
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Webhook processing error:', err);
    res.status(200).json({ success: true }); // Still return 200 to not spam retries
  }
});

// GET /api/pluggy/sync/:itemId — Fetch transactions from a connected bank account
// Call this after an Item is successfully connected to download transactions
app.get('/api/pluggy/sync/:itemId', async (req, res) => {
  if (!pluggyClient) {
    return res.status(503).json({ error: 'Pluggy not configured' });
  }

  try {
    const { itemId } = req.params;
    const { fromDate, toDate } = req.query;
    // fromDate, toDate: optional ISO 8601 strings for filtering (default: last 90 days)

    // Get all accounts linked to this Item
    const accountsList = await pluggyClient.fetchAccounts(itemId);

    if (!accountsList?.length) {
      return res.json({ transactions: [], accounts: [] });
    }

    // Fetch transactions from all accounts
    const allTransactions = [];
    for (const account of accountsList) {
      try {
        const txns = await pluggyClient.fetchTransactions(itemId, {
          accountId: account.id,
          from: fromDate || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
          to: toDate || new Date().toISOString(),
        });

        // Normalize Pluggy transaction format to our internal format
        const txnsList = Array.isArray(txns) ? txns : (txns.results || []);
        const normalized = txnsList.map(t => ({
          date: t.date.split('T')[0], // ISO YYYY-MM-DD
          description: t.description,
          originalDescription: t.descriptionRaw,
          amount: t.type === 'DEBIT' ? -Math.abs(t.amount) : Math.abs(t.amount), // Negative = expense
          category: t.category || 'Other',
          merchant: t.merchant?.name,
          paymentMethod: t.paymentData?.paymentMethod,
          accountId: account.id,
          accountName: account.name,
          source: 'pluggy'
        }));

        allTransactions.push(...normalized);
      } catch (err) {
        console.error(`Error fetching transactions for account ${account.id}:`, err);
      }
    }

    res.json({ transactions: allTransactions, accounts: accountsList });
  } catch (error) {
    console.error('Pluggy sync error:', error);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// DELETE /api/pluggy/disconnect/:itemId — Disconnect a bank account
// Removes the stored credentials/token and deletes data from Pluggy
app.delete('/api/pluggy/disconnect/:itemId', async (req, res) => {
  if (!pluggyClient) {
    return res.status(503).json({ error: 'Pluggy not configured' });
  }

  try {
    const { itemId } = req.params;

    // Delete the Item from Pluggy (this triggers data deletion on their end)
    await pluggyClient.deleteItem(itemId);

    res.json({ success: true, message: `Item ${itemId} disconnected and data scheduled for deletion` });
  } catch (error) {
    console.error('Pluggy disconnect error:', error);
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MyBudget backend running on port ${PORT}`);
});
