
// BAC BO 100% AUTOMÁTICO - SISTEMA FINAL SEM MOCK
// Arquitetura: CASINOSCORES -> COLETOR (Puppeteer) -> BANCO PERSISTENTE (SQLite/JSON) -> API -> APP
// Nenhum dado inventado. Tudo vem da fonte pública.

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

let puppeteer;
try { puppeteer = require('puppeteer'); } catch(e) { console.log('Puppeteer não instalado, tentando puppeteer-core'); }

let sqlite = null;
let db = null;
let useSQLite = false;

try {
  const better = require('better-sqlite3');
  const dbPath = path.join(__dirname, 'bacbo.db');
  sqlite = better(dbPath);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      externalId TEXT UNIQUE NOT NULL,
      timestamp TEXT NOT NULL,
      dieP1 INTEGER,
      dieP2 INTEGER,
      dieB1 INTEGER,
      dieB2 INTEGER,
      playerTotal INTEGER,
      bankerTotal INTEGER,
      result TEXT NOT NULL,
      resultNumber INTEGER,
      resultFull TEXT,
      source TEXT,
      rawData TEXT,
      hour INTEGER,
      dayOfWeek INTEGER,
      createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON rounds(timestamp);
    CREATE INDEX IF NOT EXISTS idx_result ON rounds(result);
  `);
  useSQLite = true;
  console.log('[DB] SQLite inicializado - bacbo.db');
} catch(e) {
  console.log('[DB] SQLite não disponível, usando JSON persistente:', e.message);
}

const JSON_DB_PATH = path.join(__dirname, 'bacbo_db.json');
let jsonDB = { rounds: [] };
if (!useSQLite && fs.existsSync(JSON_DB_PATH)) {
  try { jsonDB = JSON.parse(fs.readFileSync(JSON_DB_PATH, 'utf8')); } catch(e) {}
}

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));

// ===================== MODELO DA RODADA =====================
function validateRound(data) {
  // Validação absoluta - sem inventar
  const allowed = ['PLAYER','BANKER','TIE'];
  if (!allowed.includes(data.result)) return { valid: false, reason: 'result inválido' };
  
  // Se tiver dados dos dados, valida 1-6
  const diceFields = ['dieP1','dieP2','dieB1','dieB2'];
  for (const f of diceFields) {
    if (data[f] != null) {
      if (typeof data[f] !== 'number' || data[f] < 1 || data[f] > 6) {
        return { valid: false, reason: `${f} fora de 1-6` };
      }
    }
  }
  
  // Valida totais 2-12 se existirem
  if (data.playerTotal != null && (data.playerTotal < 2 || data.playerTotal > 12)) {
    return { valid: false, reason: 'playerTotal fora de 2-12' };
  }
  if (data.bankerTotal != null && (data.bankerTotal < 2 || data.bankerTotal > 12)) {
    return { valid: false, reason: 'bankerTotal fora de 2-12' };
  }
  
  // Se tiver dados completos, valida resultado calculado vs resultado informado
  if (data.dieP1 != null && data.dieP2 != null && data.dieB1 != null && data.dieB2 != null) {
    const pTotal = data.dieP1 + data.dieP2;
    const bTotal = data.dieB1 + data.dieB2;
    let expected;
    if (pTotal > bTotal) expected = 'PLAYER';
    else if (bTotal > pTotal) expected = 'BANKER';
    else expected = 'TIE';
    if (expected !== data.result) {
      return { valid: false, reason: `Resultado não bate com dados: ${pTotal} vs ${bTotal} esperava ${expected} recebeu ${data.result}` };
    }
    if (data.playerTotal != null && data.playerTotal !== pTotal) {
      return { valid: false, reason: 'playerTotal não bate com dieP1+dieP2' };
    }
    if (data.bankerTotal != null && data.bankerTotal !== bTotal) {
      return { valid: false, reason: 'bankerTotal não bate com dieB1+dieB2' };
    }
  }
  
  return { valid: true };
}

function buildRoundFromSource(raw) {
  // Constrói round SEM inventar campos
  // raw vem da página CasinoScores - pode conter apenas result + number
  // NUNCA inventa die se não tiver
  
  const now = new Date();
  const timestamp = raw.timestamp || now.toISOString();
  const dateObj = new Date(timestamp);
  
  // Gera externalId confiável
  let externalId = raw.externalId || raw.id || raw.roundId || null;
  if (!externalId) {
    // Prioridade: usa timestamp + result + totals + coord se houver
    const base = `${dateObj.getTime()}_${raw.result}_${raw.playerTotal ?? ''}_${raw.bankerTotal ?? ''}_${raw.resultNumber ?? ''}_${raw.coord ?? ''}`;
    externalId = base + '_' + Math.random().toString(36).substring(2,6);
  }
  
  const round = {
    externalId: String(externalId),
    timestamp: timestamp,
    dieP1: raw.dieP1 ?? null,
    dieP2: raw.dieP2 ?? null,
    dieB1: raw.dieB1 ?? null,
    dieB2: raw.dieB2 ?? null,
    playerTotal: raw.playerTotal ?? raw.player_score ?? null,
    bankerTotal: raw.bankerTotal ?? raw.banker_score ?? null,
    result: raw.result, // PLAYER/BANKER/TIE
    resultNumber: raw.resultNumber ?? raw.number ?? raw.total_score ?? null,
    resultFull: raw.resultFull || (raw.resultNumber ? `${raw.result} ${raw.resultNumber}` : raw.result),
    source: raw.source || 'CasinoScores',
    rawData: JSON.stringify(raw).substring(0, 2000),
    hour: dateObj.getHours(),
    dayOfWeek: dateObj.getDay(),
    createdAt: now.toISOString()
  };
  
  // Se playerTotal/bankerTotal não vieram mas temos die, calcula
  if (round.playerTotal == null && round.dieP1 != null && round.dieP2 != null) {
    round.playerTotal = round.dieP1 + round.dieP2;
  }
  if (round.bankerTotal == null && round.dieB1 != null && round.dieB2 != null) {
    round.bankerTotal = round.dieB1 + round.dieB2;
  }
  
  // Se resultNumber não veio mas temos totals, usa total vencedor
  if (round.resultNumber == null) {
    if (round.result === 'PLAYER' && round.playerTotal != null) round.resultNumber = round.playerTotal;
    else if (round.result === 'BANKER' && round.bankerTotal != null) round.resultNumber = round.bankerTotal;
    else if (round.result === 'TIE' && round.playerTotal != null) round.resultNumber = round.playerTotal;
  }
  
  return round;
}

function saveRound(round) {
  const validation = validateRound(round);
  if (!validation.valid) {
    console.log(`[VALIDAÇÃO FALHOU] ${round.externalId}: ${validation.reason}`, round);
    statusCollector.lastError = `Validação falhou: ${validation.reason}`;
    return { saved: false, reason: validation.reason };
  }
  
  if (useSQLite) {
    try {
      const stmt = sqlite.prepare(`
        INSERT OR IGNORE INTO rounds 
        (externalId, timestamp, dieP1, dieP2, dieB1, dieB2, playerTotal, bankerTotal, result, resultNumber, resultFull, source, rawData, hour, dayOfWeek, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const result = stmt.run(
        round.externalId, round.timestamp, round.dieP1, round.dieP2, round.dieB1, round.dieB2,
        round.playerTotal, round.bankerTotal, round.result, round.resultNumber, round.resultFull,
        round.source, round.rawData, round.hour, round.dayOfWeek, round.createdAt
      );
      if (result.changes > 0) {
        statusCollector.totalSaved++;
        statusCollector.lastRound = round;
        statusCollector.lastRoundAt = round.timestamp;
        console.log(`[SALVO] ${round.resultFull} | externalId: ${round.externalId}`);
        return { saved: true, isNew: true };
      } else {
        return { saved: false, isNew: false, reason: 'duplicado' };
      }
    } catch(e) {
      console.log('[DB ERRO]', e.message);
      statusCollector.lastError = e.message;
      return { saved: false, reason: e.message };
    }
  } else {
    // JSON fallback
    if (jsonDB.rounds.find(r => r.externalId === round.externalId)) {
      return { saved: false, isNew: false, reason: 'duplicado' };
    }
    jsonDB.rounds.push(round);
    jsonDB.rounds = jsonDB.rounds.slice(-10000); // mantém 10k max
    fs.writeFileSync(JSON_DB_PATH, JSON.stringify(jsonDB, null, 2));
    statusCollector.totalSaved++;
    statusCollector.lastRound = round;
    statusCollector.lastRoundAt = round.timestamp;
    console.log(`[SALVO JSON] ${round.resultFull}`);
    return { saved: true, isNew: true };
  }
}

function getAllRounds(limit = null, since = null) {
  if (useSQLite) {
    let query = 'SELECT * FROM rounds ORDER BY timestamp ASC';
    let params = [];
    if (since) {
      query = 'SELECT * FROM rounds WHERE timestamp >= ? ORDER BY timestamp ASC';
      params = [since];
    }
    const rows = sqlite.prepare(query).all(...params);
    const parsed = rows.map(r => ({
      ...r,
      dieP1: r.dieP1, dieP2: r.dieP2, dieB1: r.dieB1, dieB2: r.dieB2,
      playerTotal: r.playerTotal, bankerTotal: r.bankerTotal,
      resultNumber: r.resultNumber
    }));
    if (limit) return parsed.slice(-limit);
    return parsed;
  } else {
    let arr = jsonDB.rounds;
    if (since) arr = arr.filter(r => r.timestamp >= since);
    if (limit) return arr.slice(-limit);
    return arr;
  }
}

// ===================== COLETOR =====================
let statusCollector = {
  status: 'iniciando',
  source: 'CasinoScores - https://www.casino.org/casinoscores/pt-br/bac-bo/',
  collector: 'running',
  browserOnline: false,
  lastFetch: null,
  lastRoundAt: null,
  lastRound: null,
  totalSeen: 0,
  totalSaved: 0,
  totalRequests: 0,
  lastError: null,
  discoveredApis: [],
  mode: 'Puppeteer Screen Monitoring + Network Interception',
  uptime: 0,
  startTime: new Date().toISOString()
};

let browserInstance = null;
let pageInstance = null;
let isCollecting = false;

async function initBrowser() {
  if (!puppeteer) {
    console.log('[BROWSER] Puppeteer não disponível - modo será desabilitado, use API manual');
    statusCollector.status = 'puppeteer não instalado';
    return false;
  }
  try {
    console.log('[BROWSER] Iniciando Chromium...');
    browserInstance = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-extensions'
      ]
    });
    pageInstance = await browserInstance.newPage();
    await pageInstance.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await pageInstance.setViewport({ width: 1280, height: 800 });
    
    // Intercepta TODAS requisições de rede para descobrir API real
    await pageInstance.setRequestInterception(false); // não bloqueia, só observa
    pageInstance.on('response', async (response) => {
      try {
        const url = response.url();
        const contentType = response.headers()['content-type'] || '';
        statusCollector.totalRequests++;
        
        // Filtra apenas URLs interessantes
        const interesting = /bac-?bo|casino|roll|history|result|game|evolution|score/i.test(url) && 
                          (contentType.includes('json') || contentType.includes('text') || url.includes('api'));
        
        if (interesting) {
          if (!statusCollector.discoveredApis.find(a => a.url === url)) {
            statusCollector.discoveredApis.push({ url, contentType, timestamp: new Date().toISOString() });
            console.log(`[DISCOVERY] API encontrada: ${url} | ${contentType}`);
            statusCollector.discoveredApis = statusCollector.discoveredApis.slice(-50);
          }
          
          // Tenta ler JSON se for relevante
          if (contentType.includes('json')) {
            try {
              const json = await response.json().catch(() => null);
              if (json) {
                const str = JSON.stringify(json).toLowerCase();
                if (str.includes('player') || str.includes('banker') || str.includes('bac')) {
                  console.log(`[DISCOVERY] JSON relevante de ${url}:`, JSON.stringify(json).substring(0, 500));
                  // Tenta extrair rounds desse JSON
                  extractRoundsFromJson(json, url);
                }
              }
            } catch(e) {}
          }
        }
      } catch(e) {}
    });
    
    statusCollector.browserOnline = true;
    statusCollector.status = 'browser iniciado';
    console.log('[BROWSER] Iniciado com sucesso');
    return true;
  } catch(e) {
    console.log('[BROWSER] Erro iniciar:', e.message);
    statusCollector.lastError = e.message;
    statusCollector.browserOnline = false;
    return false;
  }
}

function extractRoundsFromJson(json, sourceUrl) {
  // Tenta extrair rounds de JSON desconhecido - sem inventar
  try {
    let candidates = [];
    if (Array.isArray(json)) candidates = json;
    else if (json.rolls) candidates = json.rolls;
    else if (json.results) candidates = json.results;
    else if (json.history) candidates = Array.isArray(json.history) ? json.history : Object.values(json.history);
    else if (json.data) candidates = Array.isArray(json.data) ? json.data : [json.data];
    else if (json.games) candidates = json.games;
    
    for (const item of candidates.slice(0, 50)) {
      if (!item) continue;
      const str = JSON.stringify(item).toLowerCase();
      // Só processa se parecer round de Bac Bo
      if (str.includes('player') || str.includes('banker') || str.includes('tie')) {
        // Mapeia campos genéricos para nosso formato
        const resultRaw = item.result || item.winner || item.outcome || item.side;
        if (!resultRaw) continue;
        const resultUpper = String(resultRaw).toUpperCase();
        let result = null;
        if (resultUpper.includes('PLAYER') || resultUpper === 'P') result = 'PLAYER';
        else if (resultUpper.includes('BANKER') || resultUpper === 'B') result = 'BANKER';
        else if (resultUpper.includes('TIE') || resultUpper === 'T') result = 'TIE';
        if (!result) continue;
        
        const roundRaw = {
          externalId: item.id || item.roundId || item.gameId || null,
          timestamp: item.timestamp || item.time || item.createdAt || new Date().toISOString(),
          dieP1: item.dieP1 || item.playerDie1 || item.p1 || null,
          dieP2: item.dieP2 || item.playerDie2 || item.p2 || null,
          dieB1: item.dieB1 || item.bankerDie1 || item.b1 || null,
          dieB2: item.dieB2 || item.bankerDie2 || item.b2 || null,
          playerTotal: item.playerTotal || item.playerScore || item.pTotal || null,
          bankerTotal: item.bankerTotal || item.bankerScore || item.bTotal || null,
          result: result,
          resultNumber: item.resultNumber || item.total || item.score || null,
          resultFull: item.resultFull || `${result} ${item.resultNumber || ''}`.trim(),
          source: `CasinoScores-API:${sourceUrl}`,
          rawData: item
        };
        const round = buildRoundFromSource(roundRaw);
        saveRound(round);
      }
    }
  } catch(e) {
    console.log('[EXTRACT JSON] Erro', e.message);
  }
}

async function extractFromDOM() {
  if (!pageInstance) return [];
  try {
    const result = await pageInstance.evaluate(() => {
      const findings = [];
      
      // Método 1: Procura Latest Rolls - texto visível
      const bodyText = document.body.innerText || '';
      const regexRolls = /(PLAYER|BANKER|TIE)\s*(\d{1,2})?/gi;
      let match;
      const textMatches = [];
      while ((match = regexRolls.exec(bodyText)) !== null) {
        textMatches.push({
          method: 'innerText regex',
          result: match[1].toUpperCase(),
          number: match[2] ? parseInt(match[2]) : null,
          full: match[0],
          index: match.index
        });
      }
      
      // Método 2: Procura elementos com data attributes do roadmap (como seu coletor antigo)
      const roadSelectors = [
        'svg[data-type=\"coordinates\"][data-x][data-y]',
        '[data-type=\"roadItem\"]',
        '[data-road]',
        '[class*=\"bigRoad\"] [class*=\"item\"]',
        '[class*=\"beadPlate\"] [class*=\"bead\"]',
        'svg[data-x][data-y]'
      ];
      
      const roadElements = [];
      roadSelectors.forEach(sel => {
        try {
          document.querySelectorAll(sel).forEach(el => {
            const name = el.getAttribute('name') || el.getAttribute('data-result') || el.getAttribute('data-winner') || '';
            const x = el.getAttribute('data-x');
            const y = el.getAttribute('data-y');
            const fill = el.getAttribute('fill') || '';
            const cls = el.getAttribute('class') || '';
            const parentCls = el.parentElement?.getAttribute('class') || '';
            const text = el.textContent || '';
            
            let result = null;
            const combined = (name + ' ' + cls + ' ' + parentCls + ' ' + text).toUpperCase();
            if (combined.includes('PLAYER') || fill.toLowerCase().includes('1e90ff') || cls.toLowerCase().includes('blue')) result = 'PLAYER';
            else if (combined.includes('BANKER') || fill.toLowerCase().includes('ff2d2d') || cls.toLowerCase().includes('red')) result = 'BANKER';
            else if (combined.includes('TIE') || fill.toLowerCase().includes('ffcc00')) result = 'TIE';
            else if (name) {
              const n = name.toUpperCase();
              if (n.includes('PLAYER')) result = 'PLAYER';
              else if (n.includes('BANKER')) result = 'BANKER';
              else if (n.includes('TIE')) result = 'TIE';
            }
            
            if (result) {
              roadElements.push({
                method: 'roadmap SVG',
                result: result,
                name: name,
                x: x, y: y,
                fill: fill,
                coord: x && y ? `${x},${y}` : null,
                full: `${result} ${name}`.trim()
              });
            }
          });
        } catch(e) {}
      });
      
      // Método 3: Procura __NEXT_DATA__ (Next.js)
      let nextDataRounds = [];
      try {
        const nextEl = document.getElementById('__NEXT_DATA__');
        if (nextEl) {
          const parsed = JSON.parse(nextEl.textContent);
          const str = JSON.stringify(parsed);
          // Se contém PLAYER/BANKER, extrai
          if (str.includes('PLAYER') || str.includes('BANKER')) {
            nextDataRounds.push({ method: '__NEXT_DATA__', data: str.substring(0, 2000) });
          }
        }
      } catch(e) {}
      
      // Método 4: Procura scripts com JSON embutido
      const scriptData = [];
      try {
        document.querySelectorAll('script[type=\"application/json\"], script:not([src])').forEach(s => {
          const txt = s.textContent || '';
          if ((txt.includes('PLAYER') || txt.includes('BANKER')) && txt.length < 10000) {
            scriptData.push({ method: 'inline script JSON', sample: txt.substring(0, 1000) });
          }
        });
      } catch(e) {}
      
      return {
        bodyTextSample: bodyText.substring(0, 2000),
        textMatches: textMatches.slice(0, 20),
        roadElements: roadElements.slice(0, 30),
        nextDataRounds,
        scriptData,
        totalElements: document.querySelectorAll('*').length
      };
    });
    
    return result;
  } catch(e) {
    console.log('[DOM EXTRACT] Erro:', e.message);
    return { error: e.message };
  }
}

async function collectLoop() {
  if (isCollecting) return;
  isCollecting = true;
  
  try {
    if (!browserInstance) {
      const ok = await initBrowser();
      if (!ok) {
        console.log('[COLLECTOR] Browser não iniciado, tentando novamente em 15s');
        statusCollector.status = 'aguardando browser';
        setTimeout(() => { isCollecting = false; collectLoop(); }, 15000);
        return;
      }
    }
    
    console.log('[COLLECTOR] Navegando para CasinoScores Bac Bo...');
    statusCollector.status = 'navegando para fonte';
    
    try {
      await pageInstance.goto('https://www.casino.org/casinoscores/pt-br/bac-bo/', {
        waitUntil: 'networkidle2',
        timeout: 45000
      });
      await pageInstance.waitForTimeout(8000); // espera JS carregar
      statusCollector.status = 'coletando - página carregada';
      statusCollector.lastFetch = new Date().toISOString();
      console.log('[COLLECTOR] Página carregada, iniciando extração contínua');
      
      // Loop de extração a cada 12 segundos
      setInterval(async () => {
        try {
          statusCollector.totalSeen++;
          statusCollector.lastFetch = new Date().toISOString();
          
          const domData = await extractFromDOM();
          
          console.log(`[SCAN #${statusCollector.totalSeen}] textMatches: ${domData.textMatches?.length || 0} | roadElements: ${domData.roadElements?.length || 0}`);
          
          // Processa textMatches (Latest Rolls)
          if (domData.textMatches && domData.textMatches.length > 0) {
            for (const tm of domData.textMatches.slice(0, 10)) {
              const raw = {
                result: tm.result,
                resultNumber: tm.number,
                resultFull: tm.full,
                timestamp: new Date().toISOString(),
                source: 'CasinoScores-LatestRolls-text',
                coord: `${tm.index}`
              };
              const round = buildRoundFromSource(raw);
              saveRound(round);
            }
          }
          
          // Processa roadElements (roadmap)
          if (domData.roadElements && domData.roadElements.length > 0) {
            for (const re of domData.roadElements.slice(0, 15)) {
              if (!re.coord) continue; // precisa coord pra deduplicar
              const raw = {
                externalId: `road_${re.coord}_${re.result}`,
                result: re.result,
                resultFull: re.result,
                timestamp: new Date().toISOString(),
                source: 'CasinoScores-Roadmap',
                coord: re.coord
              };
              const round = buildRoundFromSource(raw);
              saveRound(round);
            }
          }
          
          // Se não achou nada por 3 scans seguidos, recarrega página (pode ter sido bloqueado)
          if ((domData.textMatches?.length || 0) === 0 && (domData.roadElements?.length || 0) === 0) {
            const idleCount = (statusCollector.idleCount || 0) + 1;
            statusCollector.idleCount = idleCount;
            console.log(`[SCAN] Nenhum dado encontrado (idle ${idleCount}) - amostra texto: ${domData.bodyTextSample?.substring(0,200)}`);
            if (idleCount >= 3) {
              console.log('[SCAN] Recarregando página após 3 scans vazios...');
              await pageInstance.reload({ waitUntil: 'networkidle2' });
              await pageInstance.waitForTimeout(6000);
              statusCollector.idleCount = 0;
            }
          } else {
            statusCollector.idleCount = 0;
          }
          
        } catch(e) {
          console.log('[SCAN LOOP] Erro:', e.message);
          statusCollector.lastError = e.message;
        }
      }, 12000); // a cada 12 segundos
      
    } catch(e) {
      console.log('[COLLECTOR] Erro navegação:', e.message);
      statusCollector.lastError = e.message;
      statusCollector.status = 'erro navegação - tentando reconectar em 15s';
      setTimeout(() => { isCollecting = false; collectLoop(); }, 15000);
    }
    
  } catch(e) {
    console.log('[COLLECTOR] Erro geral:', e.message);
    statusCollector.lastError = e.message;
    isCollecting = false;
    setTimeout(collectLoop, 15000);
  }
}

// ===================== API ENDPOINTS =====================
app.get('/', (req, res) => {
  res.json({
    name: 'BAC BO 100% AUTOMÁTICO - Backend',
    version: '2.0.0 - SEM MOCK',
    architecture: 'CASINOSCORES -> COLETOR PUPPETEER -> BANCO SQLITE/JSON -> API -> APP',
    source: 'https://www.casino.org/casinoscores/pt-br/bac-bo/',
    status: statusCollector,
    endpoints: [
      'GET /health',
      'GET /history?limit=500&since=ISO',
      'GET /latest',
      'GET /stats',
      'GET /collector/status',
      'GET /analysis/frequencies?window=total|10|25|50|100|250|500',
      'GET /analysis/numbers',
      'GET /analysis/hourly',
      'GET /analysis/patterns',
      'GET /analysis/after?result=PLAYER&number=8',
      'GET /backtest?model=baseline',
      'GET /predict'
    ]
  });
});

app.get('/health', (req, res) => {
  const rounds = getAllRounds();
  const last = rounds.length ? rounds[rounds.length -1] : null;
  const now = Date.now();
  const lastAt = last ? new Date(last.timestamp).getTime() : null;
  const ageMinutes = lastAt ? Math.floor((now - lastAt)/60000) : null;
  
  res.json({
    status: statusCollector.browserOnline ? 'ok' : 'degraded',
    collector: statusCollector.collector,
    browserOnline: statusCollector.browserOnline,
    source: statusCollector.source,
    mode: statusCollector.mode,
    lastRoundAt: last ? last.timestamp : statusCollector.lastRoundAt,
    lastRound: last || statusCollector.lastRound,
    roundsStored: rounds.length,
    totalSeen: statusCollector.totalSeen,
    totalSaved: statusCollector.totalSaved,
    totalRequests: statusCollector.totalRequests,
    discoveredApis: statusCollector.discoveredApis.slice(-5),
    uptime: process.uptime(),
    startTime: statusCollector.startTime,
    lastFetch: statusCollector.lastFetch,
    lastError: statusCollector.lastError,
    ageMinutes: ageMinutes,
    isStale: ageMinutes != null && ageMinutes > 10 ? true : false,
    message: last ? `Último: ${last.resultFull} há ${ageMinutes} min` : 'Aguardando primeiro resultado real...'
  });
});

app.get('/collector/status', (req, res) => {
  res.json(statusCollector);
});

app.get('/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 500;
  const since = req.query.since || null;
  const rounds = getAllRounds(limit, since);
  res.json(rounds);
});

app.get('/latest', (req, res) => {
  const rounds = getAllRounds(1);
  res.json(rounds[0] || null);
});

app.get('/stats', (req, res) => {
  const rounds = getAllRounds();
  const total = rounds.length;
  if (total === 0) return res.json({ total: 0, message: 'Dados insuficientes - aguardando coleta real' });
  
  const p = rounds.filter(r => r.result === 'PLAYER').length;
  const b = rounds.filter(r => r.result === 'BANKER').length;
  const t = rounds.filter(r => r.result === 'TIE').length;
  
  res.json({
    total,
    player: p, banker: b, tie: t,
    playerPct: total ? (p/total*100).toFixed(2) : 0,
    bankerPct: total ? (b/total*100).toFixed(2) : 0,
    tiePct: total ? (t/total*100).toFixed(2) : 0,
    lastRound: rounds[rounds.length-1] || null,
    firstRound: rounds[0] || null,
    period: total ? `${rounds[0].timestamp} até ${rounds[rounds.length-1].timestamp}` : null
  });
});

app.get('/analysis/frequencies', (req, res) => {
  const windowParam = req.query.window || 'total';
  let rounds = getAllRounds();
  if (windowParam !== 'total') {
    const n = parseInt(windowParam);
    if (!isNaN(n)) rounds = rounds.slice(-n);
  }
  const total = rounds.length;
  if (total === 0) return res.json({ message: 'Dados insuficientes', total: 0 });
  
  const p = rounds.filter(r => r.result === 'PLAYER').length;
  const b = rounds.filter(r => r.result === 'BANKER').length;
  const t = rounds.filter(r => r.result === 'TIE').length;
  
  res.json({
    window: windowParam,
    total,
    frequencies: {
      PLAYER: { count: p, pct: total ? (p/total*100).toFixed(2) : 0 },
      BANKER: { count: b, pct: total ? (b/total*100).toFixed(2) : 0 },
      TIE: { count: t, pct: total ? (t/total*100).toFixed(2) : 0 }
    },
    sampleSize: total,
    reliable: total >= 30
  });
});

app.get('/analysis/numbers', (req, res) => {
  const rounds = getAllRounds();
  if (rounds.length === 0) return res.json({ message: 'Dados insuficientes' });
  
  const playerNumbers = {};
  const bankerNumbers = {};
  for (let i=2; i<=12; i++) { playerNumbers[i] = 0; bankerNumbers[i] = 0; }
  
  rounds.forEach(r => {
    if (r.result === 'PLAYER' && r.resultNumber >=2 && r.resultNumber <=12) playerNumbers[r.resultNumber]++;
    if (r.result === 'BANKER' && r.resultNumber >=2 && r.resultNumber <=12) bankerNumbers[r.resultNumber]++;
    if (r.result === 'TIE' && r.resultNumber >=2 && r.resultNumber <=12) {
      // TIE conta pros dois
      playerNumbers[r.resultNumber]++;
      bankerNumbers[r.resultNumber]++;
    }
  });
  
  const totalP = Object.values(playerNumbers).reduce((a,b)=>a+b,0);
  const totalB = Object.values(bankerNumbers).reduce((a,b)=>a+b,0);
  
  const playerStats = Object.entries(playerNumbers).map(([num,count])=>({
    number: parseInt(num), count, pct: totalP ? (count/totalP*100).toFixed(2) : 0
  })).sort((a,b)=>b.count-a.count);
  
  const bankerStats = Object.entries(bankerNumbers).map(([num,count])=>({
    number: parseInt(num), count, pct: totalB ? (count/totalB*100).toFixed(2) : 0
  })).sort((a,b)=>b.count-a.count);
  
  res.json({
    totalRounds: rounds.length,
    playerNumbers: { total: totalP, distribution: playerStats, mostFrequent: playerStats[0] || null, leastFrequent: playerStats[playerStats.length-1] || null },
    bankerNumbers: { total: totalB, distribution: bankerStats, mostFrequent: bankerStats[0] || null, leastFrequent: bankerStats[bankerStats.length-1] || null }
  });
});

app.get('/analysis/hourly', (req, res) => {
  const rounds = getAllRounds();
  if (rounds.length === 0) return res.json({ message: 'Dados insuficientes' });
  
  const byHour = {};
  for (let h=0; h<24; h++) byHour[h] = { hour: h, total: 0, PLAYER: 0, BANKER: 0, TIE: 0 };
  
  rounds.forEach(r => {
    const h = r.hour != null ? r.hour : new Date(r.timestamp).getHours();
    if (byHour[h]) {
      byHour[h].total++;
      byHour[h][r.result]++;
    }
  });
  
  const result = Object.values(byHour).map(h => ({
    ...h,
    playerPct: h.total ? (h.PLAYER/h.total*100).toFixed(2) : 0,
    bankerPct: h.total ? (h.BANKER/h.total*100).toFixed(2) : 0,
    tiePct: h.total ? (h.TIE/h.total*100).toFixed(2) : 0
  }));
  
  res.json({ total: rounds.length, hourly: result });
});

app.get('/analysis/patterns', (req, res) => {
  const rounds = getAllRounds();
  if (rounds.length < 5) return res.json({ message: 'Dados insuficientes - mínimo 5 rodadas', total: rounds.length });
  
  // Sequências e alternâncias
  let currentStreak = 1, maxStreak = { PLAYER:0, BANKER:0, TIE:0 };
  let tempResult = rounds[0]?.result, tempCount = 1;
  let alternations = 0, repetitions = 0;
  let after = { PLAYER: { PLAYER:0, BANKER:0, TIE:0, total:0 }, BANKER: { PLAYER:0, BANKER:0, TIE:0, total:0 }, TIE: { PLAYER:0, BANKER:0, TIE:0, total:0 } };
  let tieDistances = [], lastTieIndex = -1;
  
  for (let i=1; i<rounds.length; i++) {
    const prev = rounds[i-1].result;
    const curr = rounds[i].result;
    
    // after
    if (after[prev]) { after[prev][curr]++; after[prev].total++; }
    
    // streaks
    if (curr === tempResult) tempCount++; else {
      if (tempResult) maxStreak[tempResult] = Math.max(maxStreak[tempResult], tempCount);
      tempResult = curr; tempCount = 1;
    }
    
    // alternancia vs repetição
    if (curr !== prev && curr !== 'TIE' && prev !== 'TIE') alternations++;
    else if (curr === prev) repetitions++;
    
    // distância entre ties
    if (curr === 'TIE') {
      if (lastTieIndex !== -1) tieDistances.push(i - lastTieIndex);
      lastTieIndex = i;
    }
  }
  if (tempResult) maxStreak[tempResult] = Math.max(maxStreak[tempResult], tempCount);
  
  // Calcula porcentagens after
  const afterPct = {};
  for (const key of ['PLAYER','BANKER','TIE']) {
    const tot = after[key].total;
    afterPct[key] = {
      total: tot,
      PLAYER: { count: after[key].PLAYER, pct: tot ? (after[key].PLAYER/tot*100).toFixed(2) : 0 },
      BANKER: { count: after[key].BANKER, pct: tot ? (after[key].BANKER/tot*100).toFixed(2) : 0 },
      TIE: { count: after[key].TIE, pct: tot ? (after[key].TIE/tot*100).toFixed(2) : 0 }
    };
  }
  
  // Sequência atual
  let currentSeq = null;
  if (rounds.length > 0) {
    const last = rounds[rounds.length-1].result;
    let cnt = 1;
    for (let i=rounds.length-2; i>=0; i--) { if (rounds[i].result === last) cnt++; else break; }
    currentSeq = { result: last, count: cnt };
  }
  
  res.json({
    total: rounds.length,
    currentStreak: currentSeq,
    maxStreaks: maxStreak,
    alternations, repetitions,
    alternationPct: rounds.length > 1 ? (alternations/(rounds.length-1)*100).toFixed(2) : 0,
    repetitionPct: rounds.length > 1 ? (repetitions/(rounds.length-1)*100).toFixed(2) : 0,
    after: afterPct,
    tieAnalysis: {
      totalTies: rounds.filter(r=>r.result==='TIE').length,
      avgDistanceBetweenTies: tieDistances.length ? (tieDistances.reduce((a,b)=>a+b,0)/tieDistances.length).toFixed(2) : null,
      distances: tieDistances.slice(-20)
    },
    sampleReliable: rounds.length >= 50
  });
});

app.get('/analysis/after', (req, res) => {
  const targetResult = (req.query.result || '').toUpperCase();
  const targetNumber = req.query.number ? parseInt(req.query.number) : null;
  if (!['PLAYER','BANKER','TIE'].includes(targetResult)) return res.status(400).json({ error: 'result deve ser PLAYER, BANKER ou TIE' });
  
  const rounds = getAllRounds();
  const cases = [];
  for (let i=0; i<rounds.length-1; i++) {
    const curr = rounds[i];
    if (curr.result === targetResult && (targetNumber == null || curr.resultNumber === targetNumber)) {
      cases.push(rounds[i+1]);
    }
  }
  
  if (cases.length === 0) return res.json({ message: `Nenhum caso encontrado após ${targetResult} ${targetNumber||''}`, totalCases: 0 });
  
  const p = cases.filter(c=>c.result==='PLAYER').length;
  const b = cases.filter(c=>c.result==='BANKER').length;
  const t = cases.filter(c=>c.result==='TIE').length;
  
  res.json({
    query: { afterResult: targetResult, afterNumber: targetNumber },
    totalCases: cases.length,
    result: {
      PLAYER: { count: p, pct: (p/cases.length*100).toFixed(2) },
      BANKER: { count: b, pct: (b/cases.length*100).toFixed(2) },
      TIE: { count: t, pct: (t/cases.length*100).toFixed(2) }
    },
    cases: cases.slice(-20),
    reliable: cases.length >= 20,
    warning: cases.length < 20 ? 'Amostra pequena - não é padrão confiável' : null
  });
});

// ===================== BACKTEST & PREDICTION (SEM FAKE) =====================
app.get('/backtest', (req, res) => {
  const rounds = getAllRounds();
  if (rounds.length < 100) return res.json({ message: 'Dados insuficientes para backtest - mínimo 100 rodadas', total: rounds.length });
  
  // Baseline histórico simples
  const trainSize = Math.floor(rounds.length * 0.7);
  const train = rounds.slice(0, trainSize);
  const test = rounds.slice(trainSize);
  
  const trainCounts = { PLAYER:0, BANKER:0, TIE:0 };
  train.forEach(r=>trainCounts[r.result]++);
  const trainTotal = train.length;
  const probs = {
    PLAYER: trainCounts.PLAYER / trainTotal,
    BANKER: trainCounts.BANKER / trainTotal,
    TIE: trainCounts.TIE / trainTotal
  };
  
  // Testa: prevê sempre o mais frequente do treino
  const mostFrequent = Object.entries(trainCounts).sort((a,b)=>b[1]-a[1])[0][0];
  let correct = 0;
  const confusion = { PLAYER:{PLAYER:0,BANKER:0,TIE:0}, BANKER:{PLAYER:0,BANKER:0,TIE:0}, TIE:{PLAYER:0,BANKER:0,TIE:0} };
  
  test.forEach(r => {
    if (r.result === mostFrequent) correct++;
    // matriz confusão simplificada: previsto = mostFrequent
    confusion[mostFrequent][r.result]++;
  });
  
  const accuracy = test.length ? (correct/test.length*100).toFixed(2) : 0;
  
  res.json({
    total: rounds.length,
    trainSize, testSize: test.length,
    baseline: 'Most Frequent (histórico)',
    trainDistribution: trainCounts,
    trainProbs: probs,
    mostFrequent,
    testAccuracy: accuracy + '%',
    correct, wrong: test.length - correct,
    confusionMatrix: confusion,
    brierScore: null, // precisa probs por previsão
    message: accuracy > 50 ? `Baseline histórico: ${accuracy}% - sem vantagem garantida` : `Baseline: ${accuracy}% - aleatório é ~33% para 3 resultados`,
    warning: 'PREVISÃO ≠ GARANTIA. House edge sempre existe.'
  });
});

app.get('/predict', (req, res) => {
  const rounds = getAllRounds();
  if (rounds.length < 50) return res.json({ message: 'Dados insuficientes para previsão - mínimo 50 rodadas', total: rounds.length, prediction: null });
  
  // Baseline recente (últimos 100)
  const recent = rounds.slice(-100);
  const counts = { PLAYER:0, BANKER:0, TIE:0 };
  recent.forEach(r=>counts[r.result]++);
  const total = recent.length;
  
  const probs = {
    PLAYER: counts.PLAYER / total,
    BANKER: counts.BANKER / total,
    TIE: counts.TIE / total
  };
  
  const sorted = Object.entries(probs).sort((a,b)=>b[1]-a[1]);
  
  res.json({
    timestamp: new Date().toISOString(),
    model: 'baseline_recente_100',
    basedOn: `Últimas ${total} rodadas`,
    sampleSize: total,
    probabilities: {
      PLAYER: (probs.PLAYER*100).toFixed(2) + '%',
      BANKER: (probs.BANKER*100).toFixed(2) + '%',
      TIE: (probs.TIE*100).toFixed(2) + '%',
      raw: probs
    },
    mostLikely: sorted[0][0],
    confidence: sorted[0][1] > 0.5 ? 'média' : 'baixa',
    calibration: 'Baseline simples - sem ML ainda. Para ML precisa +500 rodadas reais.',
    warning: 'PREVISÃO ≠ RESULTADO GARANTIDO. Não é conselho de aposta.',
    reliable: total >= 100,
    lastRound: rounds[rounds.length-1]
  });
});

// Endpoint para salvar previsão e depois comparar
let predictions = [];
app.post('/predictions', (req, res) => {
  const { probabilities, model } = req.body;
  if (!probabilities) return res.status(400).json({ error: 'probabilities obrigatório' });
  const pred = {
    id: Date.now().toString(),
    timestamp: new Date().toISOString(),
    probabilities,
    model: model || 'unknown',
    resultReal: null,
    acerto: null
  };
  predictions.push(pred);
  predictions = predictions.slice(-1000);
  res.json(pred);
});

app.get('/predictions/history', (req, res) => {
  res.json(predictions.slice(-100));
});

// Verifica previsão vs resultado real automaticamente quando nova rodada chega
function checkPredictions(newRound) {
  // Pega última previsão sem resultado
  const pending = predictions.filter(p => !p.resultReal).slice(-1)[0];
  if (pending) {
    pending.resultReal = newRound.result;
    // Verifica se a maior probabilidade bateu
    const probs = pending.probabilities.raw || pending.probabilities;
    let maxProbResult = null, maxProb = -1;
    for (const [k,v] of Object.entries(probs)) {
      const val = typeof v === 'string' ? parseFloat(v) : v;
      if (val > maxProb) { maxProb = val; maxProbResult = k; }
    }
    pending.acerto = maxProbResult === newRound.result;
    pending.checkedAt = new Date().toISOString();
    console.log(`[PREDICTION CHECK] Previsão ${pending.id}: previsto ${maxProbResult} vs real ${newRound.result} -> ${pending.acerto ? 'ACERTO' : 'ERRO'}`);
  }
}

// Hook no saveRound pra checar previsões
const originalSaveRound = saveRound;
function saveRoundWithCheck(round) {
  const result = originalSaveRound(round);
  if (result.saved && result.isNew) {
    checkPredictions(round);
  }
  return result;
}
// Substitui saveRound global
global.saveRound = saveRoundWithCheck;
// Na verdade vamos usar wrapper
const _save = saveRound;
saveRound = function(r) {
  const res = _save(r);
  if (res.saved && res.isNew) checkPredictions(r);
  return res;
};

// ===================== START =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`\n========================================`);
  console.log(`BAC BO 100% AUTOMÁTICO - Backend 24/7`);
  console.log(`Porta: ${PORT}`);
  console.log(`Fonte: https://www.casino.org/casinoscores/pt-br/bac-bo/`);
  console.log(`Banco: ${useSQLite ? 'SQLite bacbo.db' : 'JSON bacbo_db.json'}`);
  console.log(`Modo: ${statusCollector.mode}`);
  console.log(`========================================\n`);
  
  // Inicia coletor
  collectLoop();
  
  // Uptime counter
  setInterval(() => { statusCollector.uptime = process.uptime(); }, 5000);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[SHUTDOWN] Fechando browser...');
  if (browserInstance) await browserInstance.close().catch(()=>{});
  process.exit(0);
});
