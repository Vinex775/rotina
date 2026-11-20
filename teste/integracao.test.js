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

test('avisos: manda uma vez só por ocorrência', async () => {
  const http = cliente();
  await http('POST', '/api/auth/entrar', { email: 'vao@exemplo.com', senha: 'segredo1' });
  // inscrição de mentira apontando para uma porta fechada: o envio falha, mas não deve repetir aviso
  db.prepare('INSERT OR REPLACE INTO push_inscricoes (endpoint, uid, json, criado) VALUES (?,?,?,?)')
    .run('https://127.0.0.1:9/x', 1, JSON.stringify({ endpoint: 'https://127.0.0.1:9/x', keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } }), Date.now());
  await rodarAvisos(new Date(2026, 10, 19, 7, 56, 0));
  const marcas = db.prepare("SELECT chave FROM avisos_enviados WHERE chave LIKE 'b|b9|%'").all();
  assert.strictEqual(marcas.length, 1);
  await rodarAvisos(new Date(2026, 10, 19, 7, 58, 0));
  assert.strictEqual(db.prepare("SELECT chave FROM avisos_enviados WHERE chave LIKE 'b|b9|%'").all().length, 1);
});

test('site: serve index.html e sw.js', async () => {
  const idx = await fetch(base + '/');
  assert.strictEqual(idx.status, 200);
  assert.match(await idx.text(), /banco\.js/);
  const sw = await fetch(base + '/sw.js');
  assert.strictEqual(sw.status, 200);
});
