// Sobe o servidor de verdade (banco temporário) e testa a API, o tempo real e
// a camada banco.js (a que substitui o Firebase no navegador) com um "navegador de mentira".
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rotina-teste-'));
process.env.TZ = 'America/Sao_Paulo';
const { app, db, rodarAvisos } = require('../server');

let servidor, base;
test.before(async () => {
  await new Promise(ok => { servidor = app.listen(0, '127.0.0.1', ok); });
  base = 'http://127.0.0.1:' + servidor.address().port;
});
test.after(() => { servidor.closeAllConnections?.(); servidor.close(); });

const esperar = ms => new Promise(r => setTimeout(r, ms));
async function ate(cond, ms = 4000){
  const t0 = Date.now();
  while(Date.now() - t0 < ms){ if(await cond()) return true; await esperar(30); }
  return false;
}

// cliente HTTP com "jarra de cookies"
function cliente(){
  let cookie = '';
  return async (metodo, url, corpo, extras = {}) => {
    const r = await fetch(base + url, {
      method: metodo,
      headers: { ...(corpo !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(extras.headers || {}) },
      body: corpo !== undefined ? JSON.stringify(corpo) : undefined
    });
    const sc = r.headers.getSetCookie?.() || [];
    sc.forEach(c => { const par = c.split(';')[0]; cookie = par.endsWith('=') ? '' : par; });
    let j = null; try{ j = await r.json(); }catch(e){}
    return { status: r.status, json: j, cookie };
  };
}

test('login: cadastro, só uma conta, senha errada, sessão', async () => {
  const http = cliente();
  assert.strictEqual((await http('GET', '/api/auth/eu')).status, 401);
  assert.strictEqual((await http('POST', '/api/auth/cadastro', { email: 'ruim', senha: '123456' })).json.codigo, 'auth/invalid-email');
  assert.strictEqual((await http('POST', '/api/auth/cadastro', { email: 'a@b.com', senha: '123' })).json.codigo, 'auth/weak-password');
  const ok = await http('POST', '/api/auth/cadastro', { email: 'Vao@Exemplo.com', senha: 'segredo1' });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.json.email, 'vao@exemplo.com');
  assert.match(ok.cookie, /^rotina_sessao=/);
  assert.strictEqual((await http('GET', '/api/auth/eu')).json.email, 'vao@exemplo.com');
  // segunda conta é recusada
  const outro = cliente();
  assert.strictEqual((await outro('POST', '/api/auth/cadastro', { email: 'x@y.com', senha: 'segredo1' })).json.codigo, 'auth/signup-disabled');
  // senha errada / certa
  const t = cliente();
  assert.strictEqual((await t('POST', '/api/auth/entrar', { email: 'vao@exemplo.com', senha: 'errada1' })).json.codigo, 'auth/invalid-credential');
  assert.strictEqual((await t('POST', '/api/auth/entrar', { email: 'vao@exemplo.com', senha: 'segredo1' })).status, 200);
  assert.strictEqual((await t('GET', '/api/auth/eu')).status, 200);
  await t('POST', '/api/auth/sair', {});
  assert.strictEqual((await t('GET', '/api/auth/eu')).status, 401);
});

test('segurança: origem de outro site é barrada; caminhos inválidos recusados', async () => {
  const http = cliente();
  await http('POST', '/api/auth/entrar', { email: 'vao@exemplo.com', senha: 'segredo1' });
  const r = await http('POST', '/api/ops', { ops: [{ tipo: 'set', path: 'tarefas/a', data: { x: 1 } }] }, { headers: { Origin: 'https://site-malvado.com' } });
  assert.strictEqual(r.status, 403);
  assert.strictEqual((await http('POST', '/api/ops', { ops: [{ tipo: 'set', path: '../x', data: {} }] })).status, 400);
  assert.strictEqual((await http('POST', '/api/ops', { ops: [{ tipo: 'set', path: 'segredos/a', data: {} }] })).status, 400);
  assert.strictEqual((await http('GET', '/api/docs?col=usuarios')).status, 400);
});

test('dados: gravar, mesclar, apagar em lote, e tempo real (SSE)', async () => {
  const http = cliente();
  await http('POST', '/api/auth/entrar', { email: 'vao@exemplo.com', senha: 'segredo1' });
  const cookie = (await http('GET', '/api/auth/eu')).cookie;

  // abre o fluxo de eventos
  const eventos = [];
  const ctl = new AbortController();
  const resp = await fetch(base + '/api/fluxo', { headers: { Cookie: cookie }, signal: ctl.signal });
  assert.strictEqual(resp.status, 200);
  (async () => {
    const dec = new TextDecoder();
    try{ for await (const pedaco of resp.body) eventos.push(dec.decode(pedaco)); }catch(e){}
  })();

  await http('POST', '/api/ops', { ops: [
    { tipo: 'set', path: 'tarefas/t1', data: { id: 't1', texto: 'Estudar', ordem: 0 } },
    { tipo: 'set', path: 'tarefas/t2', data: { id: 't2', texto: 'Correr', ordem: 1 } },
    { tipo: 'set', path: '', data: { mode: 'ambos' }, merge: true }
  ] });
  assert.ok(await ate(() => eventos.join('').includes('"col":"tarefas"') && eventos.join('').includes('"col":""')), 'SSE deveria avisar tarefas e usuário');

  await http('POST', '/api/ops', { ops: [{ tipo: 'set', path: '', data: { mostrarFeriados: true }, merge: true }] });
  const user = (await http('GET', '/api/docs?col=')).json.docs[0];
  assert.deepStrictEqual(user.data, { mode: 'ambos', mostrarFeriados: true });

  await http('POST', '/api/ops', { ops: [{ tipo: 'delete', path: 'tarefas/t1' }, { tipo: 'set', path: 'tarefas/t2', data: { id: 't2', texto: 'Correr 5 km', ordem: 1 } }] });
  const lista = (await http('GET', '/api/docs?col=tarefas')).json.docs;
  assert.deepStrictEqual(lista.map(d => d.data.texto), ['Correr 5 km']);
  ctl.abort();
});

test('importar: aceita dados do Firestore e remove marcas antigas', async () => {
  const http = cliente();
  await http('POST', '/api/auth/entrar', { email: 'vao@exemplo.com', senha: 'segredo1' });
  const r = await http('POST', '/api/importar', {
    usuario: { mode: 'meio', tokensNotificacao: ['x'], mostrarFeriados: false },
    blocos: [{ id: 'b9', dia: 4, inicio: '08:00', texto: 'Café', avisoAntes: 5, ultimaNotificacao: 'antiga' }],
    eventos: [{ id: 'e9', titulo: 'Festa', dataInicio: '2026-12-01', ultimaNotificacao: 'x' }],
    tarefas: [{ id: 'ruim id!', texto: 'não entra' }]
  });
  assert.strictEqual(r.json.importados, 2);
  const blocos = (await http('GET', '/api/docs?col=blocos')).json.docs;
  assert.strictEqual(blocos.find(b => b.id === 'b9').data.ultimaNotificacao, undefined);
  const u = (await http('GET', '/api/docs?col=')).json.docs[0].data;
  assert.strictEqual(u.mode, 'meio'); assert.strictEqual(u.tokensNotificacao, undefined);
});

// ---- avisos e falhas de envio -------------------------------------------------------
// Os testes trocam o envio real (web-push) por um de mentira, para controlar o resultado.
const webpush = require('web-push');
const envioReal = webpush.sendNotification;
const { MAX_TENTATIVAS_AVISO } = require('../server');
const ENDPOINT = 'https://push.exemplo.test/aparelho1';
const ENDPOINT2 = 'https://push.exemplo.test/aparelho2';
const CHAVES = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };
const inscrever = (endpoint) => db.prepare('INSERT OR REPLACE INTO push_inscricoes (endpoint, uid, json, criado) VALUES (?,?,?,?)')
  .run(endpoint, 1, JSON.stringify({ endpoint, keys: CHAVES }), Date.now());
const marcasDoBloco = () => db.prepare("SELECT chave FROM avisos_enviados WHERE chave LIKE 'b|b9|%'").all().length;
function prepararAvisos(){
  db.prepare('DELETE FROM avisos_enviados').run();
  db.prepare('DELETE FROM push_inscricoes').run();
  inscrever(ENDPOINT);
}
// instante em que o bloco "b9" (cadastrado no teste de dados) está dentro da janela de aviso
const HORA_DO_AVISO = (min) => new Date(2026, 10, 19, 7, 56, 0, 0).getTime() + min * 60000;
test.after(() => { webpush.sendNotification = envioReal; });

test('avisos: manda uma vez só por ocorrência', async () => {
  prepararAvisos();
  const enviados = [];
  webpush.sendNotification = async (insc, carga) => { enviados.push(JSON.parse(carga).body); };
  await rodarAvisos(new Date(HORA_DO_AVISO(0)));
  assert.strictEqual(enviados.length, 1);
  assert.strictEqual(marcasDoBloco(), 1);
  await rodarAvisos(new Date(HORA_DO_AVISO(2)));   // checagens seguintes na mesma janela: nada de duplicado
  await rodarAvisos(new Date(HORA_DO_AVISO(4)));
  assert.strictEqual(enviados.length, 1);
  assert.strictEqual(marcasDoBloco(), 1);
});

test('avisos: se o envio falha em todos os aparelhos, tenta de novo e entrega UMA vez quando volta', async () => {
  prepararAvisos();
  let online = false; const enviados = [];
  webpush.sendNotification = async (insc, carga) => {
    if(!online){ const e = new Error('getaddrinfo ENOTFOUND'); throw e; }   // sem internet: erro sem statusCode
    enviados.push(JSON.parse(carga).body);
  };
  const log = console.error; console.error = () => {};
  try{
    await rodarAvisos(new Date(HORA_DO_AVISO(0)));
    assert.strictEqual(enviados.length, 0);
    assert.strictEqual(marcasDoBloco(), 0, 'a marca foi liberada para tentar de novo');
    await rodarAvisos(new Date(HORA_DO_AVISO(1)));
    assert.strictEqual(marcasDoBloco(), 0);
    online = true;
    await rodarAvisos(new Date(HORA_DO_AVISO(2)));
    assert.strictEqual(enviados.length, 1, 'entregou quando a internet voltou');
    assert.strictEqual(marcasDoBloco(), 1);
    await rodarAvisos(new Date(HORA_DO_AVISO(3)));
    assert.strictEqual(enviados.length, 1, 'e não repete depois');
  } finally { console.error = log; }
});

test('avisos: erro 5xx do serviço de push também tenta de novo', async () => {
  prepararAvisos();
  let falhar = true; let envios = 0;
  webpush.sendNotification = async () => { if(falhar){ const e = new Error('indisponível'); e.statusCode = 503; throw e; } envios++; };
  const log = console.error; console.error = () => {};
  try{
    await rodarAvisos(new Date(HORA_DO_AVISO(0)));
    assert.strictEqual(marcasDoBloco(), 0);
    falhar = false;
    await rodarAvisos(new Date(HORA_DO_AVISO(1)));
    assert.strictEqual(envios, 1);
    assert.strictEqual(marcasDoBloco(), 1);
  } finally { console.error = log; }
});

test('avisos: desiste depois de várias tentativas seguidas (e não repete mais)', async () => {
  prepararAvisos();
  let tentativas = 0;
  webpush.sendNotification = async () => { tentativas++; throw new Error('sem rede'); };
  const log = console.error, info = console.log; console.error = () => {}; console.log = () => {};
  try{
    for(let i = 0; i < MAX_TENTATIVAS_AVISO + 5; i++) await rodarAvisos(new Date(HORA_DO_AVISO(0) + i * 1000));
  } finally { console.error = log; console.log = info; }
  assert.strictEqual(tentativas, MAX_TENTATIVAS_AVISO, 'tentou o máximo combinado e parou');
  assert.strictEqual(marcasDoBloco(), 1, 'ficou marcado: não insiste para sempre');
});

test('avisos: aparelho que cancelou (410) é removido e o aviso não fica em tentativa infinita', async () => {
  prepararAvisos();
  let chamadas = 0;
  webpush.sendNotification = async () => { chamadas++; const e = new Error('Gone'); e.statusCode = 410; throw e; };
  await rodarAvisos(new Date(HORA_DO_AVISO(0)));
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM push_inscricoes').get().n, 0, 'inscrição morta apagada');
  assert.strictEqual(marcasDoBloco(), 1, 'sem aparelhos vivos: não tenta de novo');
  await rodarAvisos(new Date(HORA_DO_AVISO(1)));
  assert.strictEqual(chamadas, 1);
});

test('avisos: se UM aparelho recebeu, o aviso conta como entregue (não duplica no que já recebeu)', async () => {
  prepararAvisos(); inscrever(ENDPOINT2);
  const recebidos = [];
  webpush.sendNotification = async (insc) => {
    if(insc.endpoint === ENDPOINT2) throw new Error('aparelho 2 sem rede');
    recebidos.push(insc.endpoint);
  };
  const log = console.error; console.error = () => {};
  try{
    await rodarAvisos(new Date(HORA_DO_AVISO(0)));
    await rodarAvisos(new Date(HORA_DO_AVISO(1)));
    await rodarAvisos(new Date(HORA_DO_AVISO(2)));
  } finally { console.error = log; }
  assert.deepStrictEqual(recebidos, [ENDPOINT], 'o aparelho 1 recebeu uma única vez');
  assert.strictEqual(marcasDoBloco(), 1);
});

test('site: serve index.html e sw.js', async () => {
  const idx = await fetch(base + '/');
  assert.strictEqual(idx.status, 200);
  assert.match(await idx.text(), /banco\.js/);
  const sw = await fetch(base + '/sw.js');
  assert.strictEqual(sw.status, 200);
});
