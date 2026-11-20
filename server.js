// server.js — servidor caseiro do Rotina.
// Faz o papel que antes era do Firebase (banco Firestore + login) e do Cloudflare Worker /
// GitHub Actions (avisos por notificação): serve o site, guarda os dados num arquivo
// SQLite, avisa os aparelhos em tempo real (SSE) e manda as notificações (Web Push).
process.env.TZ = process.env.TZ || 'America/Sao_Paulo';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');
const webpush = require('web-push');
const { calcularAvisos, iso } = require('./notificador');

const PORTA = Number(process.env.PORT || 3000);
// 127.0.0.1 = só aceita conexões da própria máquina. O Tailscale ("tailscale serve")
// é quem entrega o acesso de fora, já com HTTPS. Assim o Rotina não fica exposto na rede de casa.
const HOST = process.env.HOST || '127.0.0.1';
const DADOS = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'dados'));
const COOKIE_SEGURO = process.env.COOKIE_SECURE === '1';
const PERMITE_CADASTRO = process.env.ALLOW_SIGNUP === '1';
const SESSAO_MS = 400 * 24 * 3600 * 1000; // ~13 meses: "lembrar deste aparelho"
const COLECOES = new Set(['tarefas', 'blocos', 'eventos', 'projetos']);

fs.mkdirSync(DADOS, { recursive: true });

// ---------------------------------------------------------------- banco
const db = new Database(path.join(DADOS, 'rotina.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    hash TEXT NOT NULL,
    criado INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessoes (
    token_hash TEXT PRIMARY KEY,
    uid INTEGER NOT NULL,
    criado INTEGER NOT NULL,
    ultimo_uso INTEGER NOT NULL,
    expira INTEGER NOT NULL
  );
  -- Cada documento do antigo Firestore vira uma linha: col = 'tarefas' | 'blocos' | ...
  -- (col = '' e id = '' é o documento do próprio usuário: modo, feriados, previsão...)
  CREATE TABLE IF NOT EXISTS docs (
    uid INTEGER NOT NULL,
    col TEXT NOT NULL,
    id TEXT NOT NULL,
    data TEXT NOT NULL,
    atualizado INTEGER NOT NULL,
    PRIMARY KEY (uid, col, id)
  );
  CREATE TABLE IF NOT EXISTS push_inscricoes (
    endpoint TEXT PRIMARY KEY,
    uid INTEGER NOT NULL,
    json TEXT NOT NULL,
    criado INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS avisos_enviados (
    uid INTEGER NOT NULL,
    chave TEXT NOT NULL,
    enviado INTEGER NOT NULL,
    PRIMARY KEY (uid, chave)
  );
  CREATE TABLE IF NOT EXISTS config (chave TEXT PRIMARY KEY, valor TEXT NOT NULL);
`);

// Chaves VAPID: a "identidade" do servidor perante o serviço de push do navegador.
// São geradas uma vez e guardadas; se forem trocadas, é preciso reativar as notificações
// em cada aparelho.
function carregarVapid(){
  const lin = db.prepare("SELECT valor FROM config WHERE chave = 'vapid'").get();
  if(lin) return JSON.parse(lin.valor);
  const chaves = webpush.generateVAPIDKeys();
  db.prepare("INSERT INTO config (chave, valor) VALUES ('vapid', ?)").run(JSON.stringify(chaves));
  return chaves;
}
const VAPID = carregarVapid();
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:rotina@localhost.invalid', VAPID.publicKey, VAPID.privateKey);

const q = {
  usuarioPorEmail: db.prepare('SELECT * FROM usuarios WHERE email = ?'),
  contaUsuarios: db.prepare('SELECT COUNT(*) AS n FROM usuarios'),
  novoUsuario: db.prepare('INSERT INTO usuarios (email, hash, criado) VALUES (?, ?, ?)'),
  novaSessao: db.prepare('INSERT INTO sessoes (token_hash, uid, criado, ultimo_uso, expira) VALUES (?, ?, ?, ?, ?)'),
  sessao: db.prepare('SELECT s.*, u.email FROM sessoes s JOIN usuarios u ON u.id = s.uid WHERE s.token_hash = ?'),
  renovaSessao: db.prepare('UPDATE sessoes SET ultimo_uso = ?, expira = ? WHERE token_hash = ?'),
  apagaSessao: db.prepare('DELETE FROM sessoes WHERE token_hash = ?'),
  limpaSessoes: db.prepare('DELETE FROM sessoes WHERE expira < ?'),
  docsDaColecao: db.prepare('SELECT id, data FROM docs WHERE uid = ? AND col = ?'),
  doc: db.prepare('SELECT data FROM docs WHERE uid = ? AND col = ? AND id = ?'),
  gravaDoc: db.prepare(`INSERT INTO docs (uid, col, id, data, atualizado) VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT (uid, col, id) DO UPDATE SET data = excluded.data, atualizado = excluded.atualizado`),
  apagaDoc: db.prepare('DELETE FROM docs WHERE uid = ? AND col = ? AND id = ?'),
  gravaPush: db.prepare(`INSERT INTO push_inscricoes (endpoint, uid, json, criado) VALUES (?, ?, ?, ?)
                         ON CONFLICT (endpoint) DO UPDATE SET uid = excluded.uid, json = excluded.json`),
  pushsDoUsuario: db.prepare('SELECT endpoint, json FROM push_inscricoes WHERE uid = ?'),
  apagaPush: db.prepare('DELETE FROM push_inscricoes WHERE endpoint = ?'),
  todosUsuarios: db.prepare('SELECT id FROM usuarios'),
  avisoJaEnviado: db.prepare('SELECT 1 FROM avisos_enviados WHERE uid = ? AND chave = ?'),
  marcaAviso: db.prepare('INSERT OR IGNORE INTO avisos_enviados (uid, chave, enviado) VALUES (?, ?, ?)'),
  limpaAvisos: db.prepare('DELETE FROM avisos_enviados WHERE enviado < ?')
};

// ---------------------------------------------------------------- senhas e sessões
function hashSenha(senha){
  return new Promise((ok, erro) => {
    const sal = crypto.randomBytes(16);
    crypto.scrypt(senha, sal, 64, (e, chave) => e ? erro(e) : ok('scrypt$' + sal.toString('hex') + '$' + chave.toString('hex')));
  });
}
function conferirSenha(senha, guardado){
  return new Promise((ok) => {
    const [tipo, salHex, hashHex] = String(guardado).split('$');
    if(tipo !== 'scrypt') return ok(false);
    crypto.scrypt(senha, Buffer.from(salHex, 'hex'), 64, (e, chave) => {
      if(e) return ok(false);
      const esperado = Buffer.from(hashHex, 'hex');
      ok(esperado.length === chave.length && crypto.timingSafeEqual(esperado, chave));
    });
  });
}
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

function lerCookie(req, nome){
  const bruto = req.headers.cookie || '';
  for(const parte of bruto.split(';')){
    const i = parte.indexOf('=');
    if(i > 0 && parte.slice(0, i).trim() === nome) return decodeURIComponent(parte.slice(i + 1).trim());
  }
  return null;
}
function enviarCookie(res, token, maxAgeMs){
  let c = 'rotina_sessao=' + encodeURIComponent(token) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(maxAgeMs / 1000);
  if(COOKIE_SEGURO) c += '; Secure';
  res.append('Set-Cookie', c);
}
function criarSessao(res, uid){
  const token = crypto.randomBytes(32).toString('base64url');
  const agora = Date.now();
  q.novaSessao.run(sha256(token), uid, agora, agora, agora + SESSAO_MS);
  enviarCookie(res, token, SESSAO_MS);
}

// Descobre quem está logado (cookie de sessão). Renova a validade a cada dia de uso,
// então quem usa o Rotina com frequência nunca precisa entrar de novo.
function autenticar(req, res, next){
  const token = lerCookie(req, 'rotina_sessao');
  if(token){
    const hash = sha256(token);
    const s = q.sessao.get(hash);
    const agora = Date.now();
    if(s && s.expira > agora){
      if(agora - s.ultimo_uso > 24 * 3600 * 1000){
        q.renovaSessao.run(agora, agora + SESSAO_MS, hash);
        enviarCookie(res, token, SESSAO_MS);
      }
      req.usuario = { id: s.uid, email: s.email };
      req.sessaoHash = hash;
      return next();
    }
  }
  res.status(401).json({ codigo: 'auth/sem-sessao', mensagem: 'Entre na sua conta.' });
}

// Freio simples contra tentativa de adivinhar senha
const tentativas = new Map(); // email -> { n, desde }
function bloqueado(email){
  const t = tentativas.get(email);
  if(!t) return false;
  if(Date.now() - t.desde > 10 * 60000){ tentativas.delete(email); return false; }
  return t.n >= 8;
}
function registrarFalha(email){
  const t = tentativas.get(email);
  if(!t || Date.now() - t.desde > 10 * 60000) tentativas.set(email, { n: 1, desde: Date.now() });
  else t.n++;
}

// ---------------------------------------------------------------- tempo real (SSE)
const conexoes = new Map(); // uid -> Set<res>
function avisarMudanca(uid, colecoes){
  const conj = conexoes.get(uid);
  if(!conj) return;
  for(const col of colecoes){
    const msg = 'data: ' + JSON.stringify({ col }) + '\n\n';
    for(const res of conj) res.write(msg);
  }
}

// ---------------------------------------------------------------- documentos
// Caminho relativo ao usuário: '' (documento do usuário) ou 'colecao/id'
function interpretarCaminho(p){
  if(p === '') return { col: '', id: '' };
  const m = /^([a-z]+)\/([A-Za-z0-9_-]{1,100})$/.exec(String(p));
  if(!m || !COLECOES.has(m[1])) return null;
  return { col: m[1], id: m[2] };
}

function aplicarOps(uid, ops){
  const mudadas = new Set();
  const agora = Date.now();
  const tx = db.transaction(() => {
    for(const op of ops){
      const alvo = interpretarCaminho(op.path);
      if(!alvo) throw Object.assign(new Error('caminho inválido'), { status: 400 });
      if(op.tipo === 'delete'){
        q.apagaDoc.run(uid, alvo.col, alvo.id);
      } else if(op.tipo === 'set'){
        if(!op.data || typeof op.data !== 'object' || Array.isArray(op.data)) throw Object.assign(new Error('dados inválidos'), { status: 400 });
        let dados = op.data;
        if(op.merge){
          const atual = q.doc.get(uid, alvo.col, alvo.id);
          dados = { ...(atual ? JSON.parse(atual.data) : {}), ...op.data };
        }
        q.gravaDoc.run(uid, alvo.col, alvo.id, JSON.stringify(dados), agora);
      } else {
        throw Object.assign(new Error('operação inválida'), { status: 400 });
      }
      mudadas.add(alvo.col);
    }
  });
  tx();
  avisarMudanca(uid, mudadas);
}

// ---------------------------------------------------------------- app
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');

// Barreira simples contra requisições vindas de outros sites (CSRF): se o navegador
// mandou "Origin", ele precisa ser o mesmo endereço em que o Rotina está.
app.use((req, res, next) => {
  if(req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin){
    try{
      if(new URL(req.headers.origin).host !== req.headers.host) return res.status(403).json({ mensagem: 'origem não permitida' });
    }catch(e){ return res.status(403).json({ mensagem: 'origem inválida' }); }
  }
  next();
});

const json = express.json({ limit: '2mb' });

app.get('/api/saude', (req, res) => res.json({ ok: true }));

// ---- login
const emailValido = e => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;

app.post('/api/auth/cadastro', json, async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const senha = String((req.body && req.body.senha) || '');
  if(!emailValido(email)) return res.status(400).json({ codigo: 'auth/invalid-email', mensagem: 'E-mail inválido.' });
  if(!senha) return res.status(400).json({ codigo: 'auth/missing-password', mensagem: 'Digite uma senha.' });
  if(senha.length < 6) return res.status(400).json({ codigo: 'auth/weak-password', mensagem: 'A senha precisa ter pelo menos 6 caracteres.' });
  // A primeira conta (a sua) sempre pode ser criada. As seguintes só com ALLOW_SIGNUP=1.
  if(q.contaUsuarios.get().n > 0 && !PERMITE_CADASTRO){
    return res.status(403).json({ codigo: 'auth/signup-disabled', mensagem: 'Este servidor não aceita novas contas.' });
  }
  if(q.usuarioPorEmail.get(email)) return res.status(409).json({ codigo: 'auth/email-already-in-use', mensagem: 'Já existe uma conta com esse e-mail.' });
  const r = q.novoUsuario.run(email, await hashSenha(senha), Date.now());
  const uid = Number(r.lastInsertRowid);
  criarSessao(res, uid);
  res.json({ uid: String(uid), email });
});

app.post('/api/auth/entrar', json, async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const senha = String((req.body && req.body.senha) || '');
  if(!emailValido(email)) return res.status(400).json({ codigo: 'auth/invalid-email', mensagem: 'E-mail inválido.' });
  if(!senha) return res.status(400).json({ codigo: 'auth/missing-password', mensagem: 'Digite uma senha.' });
  if(bloqueado(email)) return res.status(429).json({ codigo: 'auth/too-many-requests', mensagem: 'Muitas tentativas.' });
  const u = q.usuarioPorEmail.get(email);
  // confere mesmo se o e-mail não existe (tempo parecido), para não revelar quais contas existem
  const ok = await conferirSenha(senha, u ? u.hash : 'scrypt$00$00');
  if(!u || !ok){
    registrarFalha(email);
    return res.status(401).json({ codigo: 'auth/invalid-credential', mensagem: 'E-mail ou senha incorretos.' });
  }
  tentativas.delete(email);
  criarSessao(res, u.id);
  res.json({ uid: String(u.id), email: u.email });
});

app.post('/api/auth/sair', autenticar, (req, res) => {
  q.apagaSessao.run(req.sessaoHash);
  res.append('Set-Cookie', 'rotina_sessao=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + (COOKIE_SEGURO ? '; Secure' : ''));
  res.json({ ok: true });
});

app.get('/api/auth/eu', autenticar, (req, res) => res.json({ uid: String(req.usuario.id), email: req.usuario.email }));

// ---- dados
app.get('/api/docs', autenticar, (req, res) => {
  const col = String(req.query.col || '');
  if(col !== '' && !COLECOES.has(col)) return res.status(400).json({ mensagem: 'coleção inválida' });
  const linhas = q.docsDaColecao.all(req.usuario.id, col);
  res.json({ docs: linhas.map(l => ({ id: l.id, data: JSON.parse(l.data) })) });
});

app.post('/api/ops', autenticar, json, (req, res) => {
  const ops = req.body && req.body.ops;
  if(!Array.isArray(ops) || ops.length === 0 || ops.length > 500) return res.status(400).json({ mensagem: 'operações inválidas' });
  try{
    aplicarOps(req.usuario.id, ops);
    res.json({ ok: true });
  }catch(e){
    res.status(e.status || 500).json({ mensagem: e.message });
  }
});

// Fluxo de eventos: o navegador deixa esta conexão aberta e o servidor avisa
// "a coleção X mudou" quando qualquer aparelho grava alguma coisa.
app.get('/api/fluxo', autenticar, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  const uid = req.usuario.id;
  if(!conexoes.has(uid)) conexoes.set(uid, new Set());
  conexoes.get(uid).add(res);
  const batida = setInterval(() => res.write(': batida\n\n'), 25000);
  req.on('close', () => {
    clearInterval(batida);
    const conj = conexoes.get(uid);
    if(conj){ conj.delete(res); if(conj.size === 0) conexoes.delete(uid); }
  });
});

// ---- importar dados exportados do Firestore (veja importar.html)
app.post('/api/importar', autenticar, express.json({ limit: '30mb' }), (req, res) => {
  const b = req.body || {};
  const ops = [];
  const limpar = (o) => { const c = { ...o }; delete c.ultimaNotificacao; return c; };
  if(b.usuario && typeof b.usuario === 'object'){
    const u = limpar(b.usuario); delete u.tokensNotificacao; delete u.tasks;
    ops.push({ tipo: 'set', path: '', data: u, merge: true });
  }
  let total = 0;
  for(const col of COLECOES){
    for(const item of (Array.isArray(b[col]) ? b[col] : [])){
      if(!item || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(item.id)) continue;
      ops.push({ tipo: 'set', path: col + '/' + item.id, data: limpar(item) });
      total++;
    }
  }
  try{
    for(let i = 0; i < ops.length; i += 400) aplicarOps(req.usuario.id, ops.slice(i, i + 400));
    res.json({ ok: true, importados: total });
  }catch(e){
    res.status(e.status || 500).json({ mensagem: e.message });
  }
});

// ---- notificações push
app.get('/api/push/chave', autenticar, (req, res) => res.json({ chave: VAPID.publicKey }));

async function enviarPush(inscricao, carga){
  try{
    await webpush.sendNotification(JSON.parse(inscricao.json), JSON.stringify(carga), { TTL: 3600, urgency: 'high' });
    return true;
  }catch(e){
    // 404/410: o aparelho cancelou ou a inscrição expirou — não adianta guardar
    if(e.statusCode === 404 || e.statusCode === 410) q.apagaPush.run(inscricao.endpoint);
    else console.error('[push] falha ao enviar:', e.statusCode || '', e.body || e.message);
    return false;
  }
}

app.post('/api/push/inscrever', autenticar, json, async (req, res) => {
  const s = req.body && req.body.inscricao;
  if(!s || typeof s.endpoint !== 'string' || !s.keys || !s.keys.p256dh || !s.keys.auth) return res.status(400).json({ mensagem: 'inscrição inválida' });
  q.gravaPush.run(s.endpoint, req.usuario.id, JSON.stringify(s), Date.now());
  const ok = await enviarPush({ endpoint: s.endpoint, json: JSON.stringify(s) }, { title: 'Rotina', body: 'Notificações ativadas neste aparelho.', tag: 'rotina-teste' });
  res.json({ ok: true, teste: ok });
});

// ---- site (arquivos da pasta public/)
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => res.set('Cache-Control', 'no-cache') // sempre confere se há versão nova
}));
app.use('/api', (req, res) => res.status(404).json({ mensagem: 'não encontrado' }));

// ---------------------------------------------------------------- avisos agendados
async function rodarAvisos(agora = new Date()){
  for(const { id: uid } of q.todosUsuarios.all()){
    const pushs = q.pushsDoUsuario.all(uid);
    if(pushs.length === 0) continue;
    const blocos = q.docsDaColecao.all(uid, 'blocos').map(l => JSON.parse(l.data));
    const eventos = q.docsDaColecao.all(uid, 'eventos').map(l => JSON.parse(l.data));
    for(const aviso of calcularAvisos(agora, blocos, eventos)){
      // marca ANTES de enviar: melhor perder um aviso por falha do que mandar duplicado
      if(q.avisoJaEnviado.get(uid, aviso.chave)) continue;
      q.marcaAviso.run(uid, aviso.chave, Date.now());
      await Promise.all(pushs.map(p => enviarPush(p, { title: aviso.titulo, body: aviso.corpo, tag: aviso.tag })));
      console.log('[aviso]', aviso.titulo + ' — ' + aviso.corpo);
    }
  }
  q.limpaAvisos.run(Date.now() - 7 * 24 * 3600 * 1000);
  q.limpaSessoes.run(Date.now());
}

// Cópia de segurança diária do banco (por volta das 03:00), guardando as últimas 14.
// Aponte o Syncthing para a pasta dados/copias para ter uma cópia fora deste computador.
let ultimaCopia = '';
async function copiaDiaria(agora = new Date()){
  const dia = iso(agora); // data local (fuso do servidor)
  if(agora.getHours() < 3 || ultimaCopia === dia) return;
  const pasta = path.join(DADOS, 'copias');
  fs.mkdirSync(pasta, { recursive: true });
  const destino = path.join(pasta, 'rotina-' + dia + '.db');
  if(!fs.existsSync(destino)) await db.backup(destino);
  ultimaCopia = dia;
  const antigas = fs.readdirSync(pasta).filter(f => /^rotina-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -14);
  for(const f of antigas) fs.unlinkSync(path.join(pasta, f));
}

function tique(){
  rodarAvisos().catch(e => console.error('[avisos]', e));
  copiaDiaria().catch(e => console.error('[copia]', e));
}

if(require.main === module){
  const servidor = app.listen(PORTA, HOST, () => {
    console.log('Rotina rodando em http://' + HOST + ':' + PORTA + ' (fuso ' + process.env.TZ + ')');
  });
  setInterval(tique, 30000);
  setTimeout(tique, 3000);
  const parar = () => { servidor.close(); db.close(); process.exit(0); };
  process.on('SIGTERM', parar);
  process.on('SIGINT', parar);
}

module.exports = { app, db, rodarAvisos, aplicarOps };
