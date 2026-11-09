// Gera os workflows em ../workflows. Uso: node build/build.js
const fs = require('fs');
const path = require('path');
const out = path.join(__dirname, '..', 'workflows');
fs.mkdirSync(out, { recursive: true });

// ---------- trechos de código compartilhados ----------
const SHOPEE_FN = `const crypto = require('crypto');
const shopee = async (query) => {
  const appId = $env.SHOPEE_APP_ID, secret = $env.SHOPEE_SECRET;
  if (!appId || !secret) throw new Error('Preencha SHOPEE_APP_ID e SHOPEE_SECRET no .env');
  const ts = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ query });
  const sig = crypto.createHash('sha256').update(appId + ts + payload + secret).digest('hex');
  const res = await this.helpers.httpRequest({
    method: 'POST',
    url: 'https://open-api.affiliate.shopee.com.br/graphql',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'SHA256 Credential=' + appId + ', Timestamp=' + ts + ', Signature=' + sig },
    body: payload, json: false,
  });
  const j = typeof res === 'string' ? JSON.parse(res) : res;
  if (j.errors) throw new Error('Shopee API: ' + JSON.stringify(j.errors));
  return j.data;
};`;

const FIELDS = 'itemId productName commissionRate commission price priceMin priceMax sales imageUrl shopName productLink offerLink ratingStar priceDiscountRate';

const NORMALIZE_FN = `const norm = (n, kw) => {
  let rate = parseFloat(n.commissionRate || 0); if (rate <= 1) rate = rate * 100;
  return {
    itemId: String(n.itemId), nome: n.productName, preco: parseFloat(n.priceMin || n.price || 0),
    precoMax: parseFloat(n.priceMax || 0), desconto: Number(n.priceDiscountRate || 0), comissaoPct: rate,
    vendas: Number(n.sales || 0), nota: parseFloat(n.ratingStar || 0), loja: n.shopName, imagem: n.imageUrl,
    linkOriginal: n.productLink, linkOferta: n.offerLink, keyword: kw || '',
  };
};`;

const CODE_BUSCAR = SHOPEE_FN + '\n' + NORMALIZE_FN + `
const kws = ($env.SHOPEE_KEYWORDS || 'achadinhos').split(',').map(s => s.trim()).filter(Boolean);
const perRun = Math.min(parseInt($env.KEYWORDS_PER_RUN || '3'), kws.length);
const sd = $getWorkflowStaticData('global');
let idx = sd.kwIdx || 0;
const out = [];
for (let i = 0; i < perRun; i++) {
  const kw = kws[(idx + i) % kws.length];
  const q = 'query { productOfferV2(keyword: ' + JSON.stringify(kw) + ', sortType: 2, page: 1, limit: 30) { nodes { ' + '${FIELDS}' + ' } } }';
  const data = await shopee(q);
  for (const n of (data.productOfferV2.nodes || [])) out.push({ json: norm(n, kw) });
}
sd.kwIdx = (idx + perRun) % kws.length;
return out;`;

const CODE_FILTRAR = `const sd = $getWorkflowStaticData('global');
const posted = new Set(sd.posted || []);
const minRating = parseFloat($env.MIN_RATING || '4.5'), minDisc = parseFloat($env.MIN_DISCOUNT || '10');
const minComm = parseFloat($env.MIN_COMMISSION_PCT || '5'), minSales = parseInt($env.MIN_SALES || '100');
const maxPrice = parseFloat($env.MAX_PRICE || '100000'), take = parseInt($env.POSTS_PER_RUN || '3');
const seen = new Set();
const ok = [];
for (const it of $input.all()) {
  const p = it.json;
  if (seen.has(p.itemId) || posted.has(p.itemId)) continue;
  seen.add(p.itemId);
  if (p.nota < minRating || p.desconto < minDisc || p.comissaoPct < minComm || p.vendas < minSales || p.preco > maxPrice || !p.imagem) continue;
  p.score = p.comissaoPct * Math.log10(p.vendas + 10) * p.nota * (1 + p.desconto / 100);
  ok.push(p);
}
ok.sort((a, b) => b.score - a.score);
const pick = ok.slice(0, take);
sd.posted = [...(sd.posted || []), ...pick.map(p => p.itemId)].slice(-2000);
return pick.map(p => ({ json: p }));`;

const CODE_LINK = SHOPEE_FN + `
const out = [];
for (const it of $input.all()) {
  const p = it.json; let link = p.linkOferta || p.linkOriginal;
  try {
    const q = 'mutation { generateShortLink(input: { originUrl: ' + JSON.stringify(p.linkOriginal) + ', subIds: [' + JSON.stringify($env.SUBID || 'n8n') + '] }) { shortLink } }';
    const d = await shopee(q);
    if (d.generateShortLink && d.generateShortLink.shortLink) link = d.generateShortLink.shortLink;
  } catch (e) { /* mantém offerLink */ }
  out.push({ json: { ...p, linkAfiliado: link } });
}
return out;`;

const GEMINI_BODY = `={{ JSON.stringify({
  contents: [{ parts: [{ text:
    'Voce e uma ' + ($env.PERSONA || 'criadora de conteudo de achadinhos') + ' escrevendo um post curto para um canal de promocoes da Shopee (pt-BR). ' +
    'Regras: tom animado e honesto; NAO invente caracteristicas que nao estao no nome do produto; NAO use urgencia falsa ("ultimas unidades"); NAO prometa resultados de saude/estetica. ' +
    'Responda APENAS um JSON: {"titulo": "ate 60 caracteres com 1 emoji", "destaque": "1 frase de ate 140 caracteres sobre por que vale a pena", "hashtags": ["4 a 6 hashtags sem espaco"]}. ' +
    'Produto: ' + $json.nome + ' | Preco: R$ ' + $json.preco + ' | Desconto: ' + $json.desconto + '% | Nota: ' + $json.nota + ' | Vendidos: ' + $json.vendas
  }] }],
  generationConfig: { responseMimeType: 'application/json', temperature: 0.9 }
}) }}`;

const CODE_MONTAR = (prev) => `const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const out = [];
const items = $input.all();
for (let i = 0; i < items.length; i++) {
  const p = $('${prev}').all()[i].json;
  let g = {};
  try {
    const txt = items[i].json.candidates[0].content.parts[0].text.replace(/\`\`\`json|\`\`\`/g, '').trim();
    g = JSON.parse(txt);
  } catch (e) { g = {}; }
  const titulo = g.titulo || p.nome.slice(0, 60);
  const destaque = g.destaque || '';
  const tags = (g.hashtags || ['#achadinhos', '#shopee']).map(t => '#' + String(t).replace(/^#/, '').replace(/\\s+/g, '')).join(' ');
  const fmt = n => n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let preco = 'R$ ' + fmt(p.preco) + (p.precoMax > p.preco ? ' a R$ ' + fmt(p.precoMax) : '');
  let cap = '<b>' + esc(titulo) + '</b>\\n\\n' + (destaque ? esc(destaque) + '\\n\\n' : '') +
    '\\u{1F4B0} ' + preco + (p.desconto ? ' (-' + Math.round(p.desconto) + '%)' : '') + '\\n' +
    '\\u2B50 ' + p.nota.toFixed(1) + ' \\u2022 \\u{1F4E6} ' + p.vendas + ' vendidos\\n\\n' +
    '\\u{1F6D2} Comprar: ' + p.linkAfiliado + '\\n\\n' + esc(tags) + '\\n\\n<i>' + esc($env.DISCLOSURE || '') + '</i>';
  if (cap.length > 1020) cap = cap.slice(0, 1015) + '...';
  out.push({ json: { chat_id: $env.TELEGRAM_CHAT_ID, photo: p.imagem, caption: cap, parse_mode: 'HTML' } });
}
return out;`;

// ---------- helpers de montagem ----------
let uid = 0;
const mk = (name, type, typeVersion, pos, parameters, extra = {}) => ({
  id: 'n' + (++uid) + '-' + Math.random().toString(16).slice(2, 8), name, type, typeVersion, position: pos, parameters, ...extra,
});
const code = (name, pos, js) => mk(name, 'n8n-nodes-base.code', 2, pos, { jsCode: js });
const gemini = (pos) => mk('Gemini - escrever legenda', 'n8n-nodes-base.httpRequest', 4.2, pos, {
  method: 'POST',
  url: "=https://generativelanguage.googleapis.com/v1beta/models/{{ $env.GEMINI_MODEL || 'gemini-2.5-flash' }}:generateContent",
  sendHeaders: true,
  headerParameters: { parameters: [{ name: 'x-goog-api-key', value: '={{ $env.GEMINI_API_KEY }}' }] },
  sendBody: true, specifyBody: 'json', jsonBody: GEMINI_BODY,
  options: { batching: { batch: { batchSize: 1, batchInterval: 4000 } } },
}, { onError: 'continueRegularOutput' });
const telegram = (pos, interval = 30000, nm = 'Telegram - postar no canal') => mk(nm, 'n8n-nodes-base.httpRequest', 4.2, pos, {
  method: 'POST',
  url: '=https://api.telegram.org/bot{{ $env.TELEGRAM_BOT_TOKEN }}/sendPhoto',
  sendBody: true, specifyBody: 'json',
  jsonBody: '={{ JSON.stringify({ chat_id: $json.chat_id, photo: $json.photo, caption: $json.caption, parse_mode: $json.parse_mode }) }}',
  options: { batching: { batch: { batchSize: 1, batchInterval: interval } } },
}, { onError: 'continueRegularOutput' });
const note = (pos, text, w = 420, h = 160) => mk('Nota', 'n8n-nodes-base.stickyNote', 1, pos, { content: text, width: w, height: h });

const chain = (nodes) => {
  const c = {};
  for (let i = 0; i < nodes.length - 1; i++) {
    c[nodes[i].name] = { main: [[{ node: nodes[i + 1].name, type: 'main', index: 0 }]] };
  }
  return c;
};
const save = (file, name, nodes, connections, id) => {
  const wf = { ...(id ? { id } : {}), name, nodes, connections, active: false, settings: { executionOrder: 'v1', timezone: 'America/Sao_Paulo' }, pinData: {} };
  fs.writeFileSync(path.join(out, file), JSON.stringify(wf, null, 2));
};

// ---------- helpers extras ----------
const ID_CANVA = 'shopeeCanva05', ID_PUBLICAR = 'shopeePublicar06';
const ifn = (name, pos, value1, value2) => mk(name, 'n8n-nodes-base.if', 1, pos, { conditions: { string: [{ value1, operation: 'equals', value2 }] } });
const wait = (name, pos, s) => mk(name, 'n8n-nodes-base.wait', 1.1, pos, { resume: 'timeInterval', amount: s, unit: 'seconds' }, { webhookId: 'w' + Math.random().toString(16).slice(2, 10) });
const exec = (name, pos, id, mode) => mk(name, 'n8n-nodes-base.executeWorkflow', 1.2, pos, { source: 'database', workflowId: { __rl: true, value: id, mode: 'id' }, mode, options: {} });
const link2 = (c, from, to, out = 0) => { c[from.name] = c[from.name] || { main: [] }; while (c[from.name].main.length <= out) c[from.name].main.push([]); c[from.name].main[out].push({ node: to.name, type: 'main', index: 0 }); };
const canvaHttp = (name, pos, method, url, body) => mk(name, 'n8n-nodes-base.httpRequest', 4.2, pos, {
  method, url, authentication: 'genericCredentialType', genericAuthType: 'oAuth2Api',
  ...(body ? { sendBody: true, specifyBody: 'json', jsonBody: body } : {}), options: {},
});
const bearer = (name, pos, url, tokenEnv, body) => mk(name, 'n8n-nodes-base.httpRequest', 4.2, pos, {
  method: 'POST', url, sendHeaders: true,
  headerParameters: { parameters: [{ name: 'Authorization', value: '=Bearer {{ $env.' + tokenEnv + ' }}' }] },
  sendBody: true, specifyBody: 'json', jsonBody: body, options: {},
}, { onError: 'continueRegularOutput' });

const CODE_EXPAND = SHOPEE_FN + `
const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = n => n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const prods = $('Receber produtos').all(), gem = $input.all(), out = [];
const bio = $env.BIO_LINK || '', disc = $env.DISCLOSURE || '';
for (let i = 0; i < gem.length; i++) {
  const p = prods[i].json; let g = {};
  try { g = JSON.parse(gem[i].json.candidates[0].content.parts[0].text.replace(/\`\`\`json|\`\`\`/g, '').trim()); } catch (e) { g = {}; }
  const titulo = g.titulo || p.nome.slice(0, 60), destaque = g.destaque || '';
  const tags = (g.hashtags || ['#achadinhos', '#shopee']).map(t => '#' + String(t).replace(/^#/, '').replace(/\\s+/g, '')).join(' ');
  const precoTxt = 'R$ ' + fmt(p.preco) + (p.precoMax > p.preco ? ' a R$ ' + fmt(p.precoMax) : '');
  const descTxt = p.desconto ? ' (-' + Math.round(p.desconto) + '%)' : '';
  for (const canal of ['tg', 'ig', 'pin', 'tt']) {
    let link = p.linkOferta || p.linkOriginal;
    try {
      const q = 'mutation { generateShortLink(input: { originUrl: ' + JSON.stringify(p.linkOriginal) + ', subIds: [' + JSON.stringify($env.SUBID || 'n8n') + ', ' + JSON.stringify(canal) + '] }) { shortLink } }';
      const d = await shopee(q);
      if (d.generateShortLink && d.generateShortLink.shortLink) link = d.generateShortLink.shortLink;
    } catch (e) { /* mantem offerLink */ }
    const base = { canal, itemId: p.itemId, nome: p.nome, imagem: p.imagem, titulo, preco: p.preco, precoTxt, descTxt, link };
    const stats = '\\u{1F4B0} ' + precoTxt + descTxt + '\\n\\u2B50 ' + p.nota.toFixed(1) + ' \\u2022 \\u{1F4E6} ' + p.vendas + ' vendidos';
    if (canal === 'tg') {
      let cap = '<b>' + esc(titulo) + '</b>\\n\\n' + (destaque ? esc(destaque) + '\\n\\n' : '') + stats + '\\n\\n\\u{1F6D2} Comprar: ' + link + '\\n\\n' + esc(tags) + '\\n\\n<i>' + esc(disc) + '</i>';
      if (cap.length > 1020) cap = cap.slice(0, 1015) + '...';
      out.push({ json: { ...base, chat_id: $env.TELEGRAM_CHAT_ID, photo: p.imagem, caption: cap, parse_mode: 'HTML' } });
    } else if (canal === 'ig') {
      out.push({ json: { ...base, caption: (titulo + '\\n\\n' + (destaque ? destaque + '\\n\\n' : '') + stats + '\\n\\n\\u{1F6D2} ' + (bio ? 'Link na bio ou aqui: ' : 'Link: ') + link + '\\n\\n' + tags + ' #shopee #achadinhos\\n\\n' + disc).slice(0, 2150) } });
    } else if (canal === 'pin') {
      out.push({ json: { ...base, pinTitle: titulo.slice(0, 100), pinDesc: (destaque + ' ' + precoTxt + descTxt + ' ' + tags + ' ' + disc).trim().slice(0, 490) } });
    } else {
      out.push({ json: { ...base, caption: (titulo + ' ' + precoTxt + descTxt + ' ' + tags + ' #shopee' + (bio ? ' Link na bio' : '')).slice(0, 2000) } });
    }
  }
}
return out;`;

// ---------- WF 06: publicar um produto em todos os canais ----------
{
  const trig = mk('Receber produtos', 'n8n-nodes-base.executeWorkflowTrigger', 1.1, [0, 0], { inputSource: 'passthrough' });
  const g = gemini([260, 0]);
  const expand = code('Expandir por canal e gerar links', [520, 0], CODE_EXPAND);
  const ifTg = ifn('E Telegram?', [780, 0], '={{ $json.canal }}', 'tg');
  const tg = telegram([1040, -160], 30000);
  const canva = exec('Canva - gerar arte', [1040, 120], ID_CANVA, 'each');
  const ifIg = ifn('E Instagram?', [1300, 120], '={{ $json.canal }}', 'ig');
  const igCria = bearer('Instagram - criar midia', [1560, 0], "=https://graph.facebook.com/v21.0/{{ $env.IG_USER_ID }}/media", 'IG_ACCESS_TOKEN',
    '={{ JSON.stringify({ image_url: $json.artUrl, caption: $json.caption }) }}');
  const igWait = wait('Aguardar processamento IG', [1820, 0], 10);
  const igPub = bearer('Instagram - publicar', [2080, 0], "=https://graph.facebook.com/v21.0/{{ $env.IG_USER_ID }}/media_publish", 'IG_ACCESS_TOKEN',
    '={{ JSON.stringify({ creation_id: $json.id }) }}');
  const ifPin = ifn('E Pinterest?', [1560, 240], '={{ $json.canal }}', 'pin');
  const pin = bearer('Pinterest - criar pin', [1820, 160], 'https://api.pinterest.com/v5/pins', 'PINTEREST_ACCESS_TOKEN',
    "={{ JSON.stringify({ board_id: $env.PINTEREST_BOARD_ID, title: $json.pinTitle, description: $json.pinDesc, link: $json.link, media_source: { source_type: 'image_url', url: $json.artUrl } }) }}");
  const ttPrep = code('TikTok - preparar', [1820, 340], `const p = $input.first().json;
return [{ json: { ...p, chat_id: $env.TELEGRAM_ADMIN_CHAT_ID, photo: p.artUrl, parse_mode: '', caption: ('TIKTOK (postar manualmente)\\n\\n' + p.caption + '\\n\\nLink de afiliado: ' + p.link).slice(0, 1020) } }];`);
  const ttApi = bearer('TikTok - API (desativado)', [2080, 340], 'https://open.tiktokapis.com/v2/post/publish/content/init/', 'TIKTOK_ACCESS_TOKEN',
    "={{ JSON.stringify({ post_info: { title: $json.titulo.slice(0, 90), description: $json.caption, privacy_level: 'SELF_ONLY' }, source_info: { source: 'PULL_FROM_URL', photo_cover_index: 0, photo_images: [$json.artUrl] }, post_mode: 'DIRECT_POST', media_type: 'PHOTO' }) }}");
  ttApi.disabled = true;
  const ttTg = telegram([2340, 340], 1000, 'Telegram - fila TikTok (manual)');
  ttTg.parameters.jsonBody = "={{ JSON.stringify({ chat_id: $('TikTok - preparar').first().json.chat_id, photo: $('TikTok - preparar').first().json.photo, caption: $('TikTok - preparar').first().json.caption }) }}";
  const nodes = [trig, g, expand, ifTg, tg, canva, ifIg, igCria, igWait, igPub, ifPin, pin, ttPrep, ttApi, ttTg,
    note([-20, -260], '## 06 - Publicar em todos os canais\nRecebe produtos ja filtrados. Gemini escreve o texto; para cada produto sao gerados 4 links (subId por canal: tg, ig, pin, tt). Telegram usa a foto do produto; Instagram, Pinterest e TikTok usam a arte do Canva (workflow 05).\nTikTok: por padrao cai na fila manual no seu Telegram (veja README).', 640, 200)];
  const c = chain([trig, g, expand, ifTg]);
  link2(c, ifTg, tg, 0); link2(c, ifTg, canva, 1); link2(c, canva, ifIg);
  link2(c, ifIg, igCria, 0); link2(c, igCria, igWait); link2(c, igWait, igPub);
  link2(c, ifIg, ifPin, 1); link2(c, ifPin, pin, 0); link2(c, ifPin, ttPrep, 1);
  link2(c, ttPrep, ttApi); link2(c, ttApi, ttTg);
  save('06-publicar-todos-canais.json', '06 - Publicar em todos os canais', nodes, c, ID_PUBLICAR);
}

// ---------- WF 05: arte no Canva ----------
{
  const trig = mk('Receber item', 'n8n-nodes-base.executeWorkflowTrigger', 1.1, [0, 0], { inputSource: 'passthrough' });
  const prep = code('Preparar', [240, 0], `const t = { ig: $env.CANVA_TEMPLATE_IG, pin: $env.CANVA_TEMPLATE_PIN, tt: $env.CANVA_TEMPLATE_TT }[$json.canal];
return [{ json: { ...$json, templateId: t || '', canvaOn: ($env.CANVA_ENABLED === 'true' && !!t) ? 'sim' : 'nao' } }];`);
  const ifOn = ifn('Canva ligado?', [480, 0], '={{ $json.canvaOn }}', 'sim');
  const sem = code('Sem Canva - usar foto do produto', [740, 300], `return [{ json: { ...$json, artUrl: $json.imagem } }];`);
  const up = canvaHttp('Canva - enviar foto do produto', [740, -100], 'POST', 'https://api.canva.com/rest/v1/url-asset-uploads',
    "={{ JSON.stringify({ name: 'shopee-' + $json.itemId, url: $json.imagem }) }}");
  const w1 = wait('Aguardar upload', [1000, -100], 4);
  const up2 = canvaHttp('Canva - status do upload', [1240, -100], 'GET', '=https://api.canva.com/rest/v1/url-asset-uploads/{{ $json.job.id }}');
  const if1 = ifn('Upload em andamento?', [1480, -100], '={{ $json.job.status }}', 'in_progress');
  const fill = canvaHttp('Canva - preencher template', [1740, -100], 'POST', 'https://api.canva.com/rest/v1/autofills',
    "={{ JSON.stringify({ brand_template_id: $('Preparar').first().json.templateId, data: { titulo: { type: 'text', text: $('Preparar').first().json.titulo }, preco: { type: 'text', text: $('Preparar').first().json.precoTxt }, desconto: { type: 'text', text: $('Preparar').first().json.descTxt.trim() || ' ' }, foto: { type: 'image', asset_id: $json.job.asset.id } } }) }}");
  const w2 = wait('Aguardar autofill', [2000, -100], 5);
  const fill2 = canvaHttp('Canva - status do autofill', [2240, -100], 'GET', '=https://api.canva.com/rest/v1/autofills/{{ $json.job.id }}');
  const if2 = ifn('Autofill em andamento?', [2480, -100], '={{ $json.job.status }}', 'in_progress');
  const exp = canvaHttp('Canva - exportar JPG', [2740, -100], 'POST', 'https://api.canva.com/rest/v1/exports',
    "={{ JSON.stringify({ design_id: $json.job.result.design.id, format: { type: 'jpg', quality: 90 } }) }}");
  const w3 = wait('Aguardar exportacao', [3000, -100], 5);
  const exp2 = canvaHttp('Canva - status da exportacao', [3240, -100], 'GET', '=https://api.canva.com/rest/v1/exports/{{ $json.job.id }}');
  const if3 = ifn('Exportacao em andamento?', [3480, -100], '={{ $json.job.status }}', 'in_progress');
  const res = code('Resultado - URL da arte', [3740, -100], `const base = $('Preparar').first().json;
const urls = ($json.job && $json.job.urls) || [];
if (!urls.length) throw new Error('Canva nao devolveu a arte: ' + JSON.stringify($json.job));
return [{ json: { ...base, artUrl: urls[0] } }];`);
  const nodes = [trig, prep, ifOn, sem, up, w1, up2, if1, fill, w2, fill2, if2, exp, w3, exp2, if3, res,
    note([-20, -300], '## 05 - Arte no Canva (sub-workflow)\nFluxo: envia a foto do produto ao Canva > preenche o template de marca (campos: titulo, preco, desconto, foto) > exporta JPG > devolve artUrl.\nSelecione SUA credencial OAuth2 do Canva nos 7 nos "Canva - ...". Se CANVA_ENABLED nao for true, usa a foto do produto.', 700, 200)];
  const c = chain([trig, prep, ifOn]);
  link2(c, ifOn, up, 0); link2(c, ifOn, sem, 1);
  link2(c, up, w1); link2(c, w1, up2); link2(c, up2, if1); link2(c, if1, w1, 0); link2(c, if1, fill, 1);
  link2(c, fill, w2); link2(c, w2, fill2); link2(c, fill2, if2); link2(c, if2, w2, 0); link2(c, if2, exp, 1);
  link2(c, exp, w3); link2(c, w3, exp2); link2(c, exp2, if3); link2(c, if3, w3, 0); link2(c, if3, res, 1);
  save('05-canva-gerar-arte.json', '05 - Canva gerar arte', nodes, c, ID_CANVA);
}

// ---------- WF 01: automático ----------
{
  const sched = mk('A cada 3 horas', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 0], { rule: { interval: [{ field: 'hours', hoursInterval: 3 }] } });
  const manual = mk('Teste manual', 'n8n-nodes-base.manualTrigger', 1, [0, 200], {});
  const buscar = code('Shopee - buscar ofertas', [260, 100], CODE_BUSCAR);
  const filtrar = code('Filtrar, evitar repetidos e ranquear', [520, 100], CODE_FILTRAR);
  const pub = exec('Publicar em todos os canais (06)', [780, 100], ID_PUBLICAR, 'once');
  const c = chain([buscar, filtrar, pub]);
  link2(c, sched, buscar); link2(c, manual, buscar);
  save('01-achadinhos-automatico.json', '01 - Achadinhos Shopee (automatico)', [sched, manual, buscar, filtrar, pub,
    note([-20, -260], '## 01 - Achadinhos automaticos\nA cada 3h: busca ofertas, filtra (nota, desconto, comissao, vendas), evita repetidos e entrega para o workflow 06, que cria texto + arte e publica em Telegram, Instagram, Pinterest e TikTok.\nAjustes: arquivo .env', 600, 200)], c);
}

// ---------- WF 02: manual por link ----------
{
  const form = mk('Formulario - colar link', 'n8n-nodes-base.formTrigger', 2.2, [0, 0], {
    formTitle: 'Postar produto da Shopee',
    formDescription: 'Cole o link do produto. Ele busca os dados, cria os links de afiliado, escreve o texto e publica em todos os canais.',
    formFields: { values: [{ fieldLabel: 'Link do produto Shopee', requiredField: true }] }, options: {},
  }, { webhookId: 'shopee-post-manual' });
  const extrair = code('Extrair ID do produto', [260, 0], `let url = $json['Link do produto Shopee'].trim();
const re = [/i\\.(\\d+)\\.(\\d+)/, /product\\/(\\d+)\\/(\\d+)/, /\\/(\\d{5,})\\/(\\d{5,})/];
const find = u => { for (const r of re) { const m = u.match(r); if (m) return { shopId: m[1], itemId: m[2] }; } return null; };
let r = find(url);
if (!r) {
  const res = await this.helpers.httpRequest({ method: 'GET', url, returnFullResponse: true, ignoreHttpStatusErrors: true, headers: { 'User-Agent': 'Mozilla/5.0' } });
  const finalUrl = (res.request && res.request.res && res.request.res.responseUrl) || (res.headers && res.headers.location) || '';
  r = find(String(finalUrl));
}
if (!r) throw new Error('Nao consegui identificar o produto nesse link. Use o link completo (.../product/SHOPID/ITEMID).');
return [{ json: r }];`);
  const buscar = code('Shopee - buscar produto', [520, 0], SHOPEE_FN + '\n' + NORMALIZE_FN + `
const q = 'query { productOfferV2(itemId: ' + $json.itemId + ', shopId: ' + $json.shopId + ', page: 1, limit: 1) { nodes { ' + '${FIELDS}' + ' } } }';
const d = await shopee(q);
const n = (d.productOfferV2.nodes || [])[0];
if (!n) throw new Error('Produto nao encontrado na API de afiliados (pode nao fazer parte do programa).');
return [{ json: norm(n, 'manual') }];`);
  const pub = exec('Publicar em todos os canais (06)', [780, 0], ID_PUBLICAR, 'once');
  save('02-post-manual-por-link.json', '02 - Post manual por link', [form, extrair, buscar, pub,
    note([-20, -240], '## 02 - Post manual\nAbra a Production URL do primeiro no, cole o link do produto e ele publica em todos os canais.', 520, 140)], chain([form, extrair, buscar, pub]));
}

// ---------- WF 03: relatório ----------
{
  const sched = mk('Todo dia 21h', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 0], { rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 21 }] } });
  const rel = code('Shopee - vendas, itens e canais', [260, 0], SHOPEE_FN + `
const end = Math.floor(Date.now() / 1000), start7 = end - 7 * 86400, start1 = end - 86400;
const q = 'query { conversionReport(purchaseTimeStart: ' + start7 + ', purchaseTimeEnd: ' + end + ', limit: 500) { nodes { purchaseTime conversionStatus totalCommission netCommission utmContent orders { orderStatus items { itemId itemName qty itemTotalCommission } } } } }';
const d = await shopee(q);
const nodes = (d.conversionReport && d.conversionReport.nodes) || [];
const nm = { tg: 'Telegram', ig: 'Instagram', pin: 'Pinterest', tt: 'TikTok' };
const resumo = (lista) => ({ conv: lista.length, comm: lista.reduce((a, n) => a + parseFloat(n.totalCommission || 0), 0) });
const dia = nodes.filter(n => Number(n.purchaseTime) >= start1);
const canais = {}, itens = {};
for (const n of nodes) {
  const partes = String(n.utmContent || '').split('-'); const c = nm[partes[partes.length - 1]] || 'Outros';
  canais[c] = canais[c] || { conv: 0, comm: 0 }; canais[c].conv++; canais[c].comm += parseFloat(n.totalCommission || 0);
  for (const o of (n.orders || [])) for (const it of (o.items || [])) {
    const k = it.itemId; itens[k] = itens[k] || { nome: it.itemName, qtd: 0, comm: 0 };
    itens[k].qtd += Number(it.qty || 1); itens[k].comm += parseFloat(it.itemTotalCommission || 0);
  }
}
const lista = Object.values(itens);
const topQtd = [...lista].sort((a, b) => b.qtd - a.qtd).slice(0, 5);
const topComm = [...lista].sort((a, b) => b.comm - a.comm).slice(0, 5);
const r1 = resumo(dia), r7 = resumo(nodes);
const linha = (i, x, v) => (i + 1) + '. ' + String(x.nome).slice(0, 45) + ' - ' + v;
const txt = 'RELATORIO SHOPEE AFILIADOS\\n\\nUltimas 24h: ' + r1.conv + ' vendas | R$ ' + r1.comm.toFixed(2) +
  '\\nUltimos 7 dias: ' + r7.conv + ' vendas | R$ ' + r7.comm.toFixed(2) +
  '\\n\\nPor canal (7 dias):\\n' + (Object.entries(canais).map(([k, v]) => '- ' + k + ': ' + v.conv + ' vendas, R$ ' + v.comm.toFixed(2)).join('\\n') || '- sem vendas') +
  '\\n\\nMais vendidos (7 dias):\\n' + (topQtd.map((x, i) => linha(i, x, x.qtd + ' un')).join('\\n') || '-') +
  '\\n\\nMais lucrativos (7 dias):\\n' + (topComm.map((x, i) => linha(i, x, 'R$ ' + x.comm.toFixed(2))).join('\\n') || '-') +
  '\\n\\nCliques: veja em Shopee Afiliados > Relatorio de cliques (a API de vendas nao traz cliques).';
return [{ json: { chat_id: $env.TELEGRAM_ADMIN_CHAT_ID, text: txt } }];`);
  const tg = mk('Telegram - enviar relatorio', 'n8n-nodes-base.httpRequest', 4.2, [520, 0], {
    method: 'POST', url: '=https://api.telegram.org/bot{{ $env.TELEGRAM_BOT_TOKEN }}/sendMessage',
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify({ chat_id: $json.chat_id, text: $json.text }) }}', options: {},
  });
  save('03-relatorio-diario.json', '03 - Relatorio de vendas e desempenho', [sched, rel, tg, note([-20, -240], '## 03 - Relatorio\nTodo dia 21h no seu Telegram: vendas 24h e 7 dias, por canal (subId), mais vendidos e mais lucrativos.\nSe a Shopee mudar algum campo, ajuste a query no no do meio.', 560, 150)], chain([sched, rel, tg]));
}

// ---------- WF 04: erro ----------
{
  const err = mk('Erro em workflow', 'n8n-nodes-base.errorTrigger', 1, [0, 0], {});
  const tg = mk('Telegram - avisar erro', 'n8n-nodes-base.httpRequest', 4.2, [260, 0], {
    method: 'POST', url: '=https://api.telegram.org/bot{{ $env.TELEGRAM_BOT_TOKEN }}/sendMessage',
    sendBody: true, specifyBody: 'json',
    jsonBody: "={{ JSON.stringify({ chat_id: $env.TELEGRAM_ADMIN_CHAT_ID, text: 'Erro no n8n: ' + $json.workflow.name + '\\n' + ($json.execution.error.message || '').slice(0, 500) }) }}", options: {},
  });
  save('04-alerta-de-erro.json', '04 - Alerta de erro (Telegram)', [err, tg, note([-20, -200], '## 04 - Alerta de erro\nEm cada workflow: Settings > Error workflow > escolha este.', 460, 110)], chain([err, tg]));
}
console.log('ok');
