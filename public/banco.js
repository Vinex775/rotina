// banco.js
// Substitui o Firebase (login + Firestore). Oferece as MESMAS funções que o resto do app
// já usa — doc, collection, setDoc, getDoc, deleteDoc, writeBatch, onSnapshot, e as de
// login — mas falando com o servidor do Rotina (pasta /api) em vez do Google.
// Por isso o index.html e o sync.js quase não mudaram: só trocaram de onde importam.
//
// O que este arquivo faz por baixo dos panos:
//  • Fila de gravação: toda alteração entra numa fila, é enviada em ordem e, se a internet/
//    servidor cair, fica guardada (também no aparelho) e é reenviada sozinha depois.
//  • Cópia local: a tela aparece na hora com os últimos dados guardados no aparelho e
//    depois é atualizada com os do servidor (é o "fromCache" que o sync.js já entende).
//  • Tempo real: uma conexão de eventos (SSE) avisa quando outro aparelho muda algo.

// ------------------------------------------------------------ chamadas ao servidor
async function chamar(metodo, url, corpo){
  let r;
  try{
    r = await fetch(url, {
      method: metodo,
      headers: corpo !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
      credentials: 'same-origin'
    });
  }catch(e){
    const erro = new Error('sem conexão com o servidor');
    erro.rede = true;
    throw erro;
  }
  if(!r.ok){
    let j = {};
    try{ j = await r.json(); }catch(e){}
    const erro = new Error(j.mensagem || ('erro ' + r.status));
    erro.code = j.codigo;      // 'auth/invalid-credential', etc. (o index.html traduz)
    erro.status = r.status;
    // 502/503/504 = servidor reiniciando / fora do ar: trata como falta de conexão
    if(r.status === 502 || r.status === 503 || r.status === 504) erro.rede = true;
    throw erro;
  }
  return r.json();
}

// ------------------------------------------------------------ login
const LS_USUARIO = 'rotina.usuario';
const PREFIXO_CACHE = 'rotina.cache.';
let usuarioAtual = null;
const ouvintesAuth = new Set();

export const auth = { get currentUser(){ return usuarioAtual; } };
export const db = { tipo: 'banco' };

function lerUsuarioLocal(){
  try{ return JSON.parse(localStorage.getItem(LS_USUARIO)); }catch(e){ return null; }
}
function guardarUsuarioLocal(u){
  try{ if(u) localStorage.setItem(LS_USUARIO, JSON.stringify(u)); else localStorage.removeItem(LS_USUARIO); }catch(e){}
}
function definirUsuario(u){
  usuarioAtual = u;
  guardarUsuarioLocal(u);
  ouvintesAuth.forEach(cb => { try{ cb(u); }catch(e){ console.error(e); } });
}

let sessaoIniciada = null;
export function onAuthStateChanged(_auth, cb){
  ouvintesAuth.add(cb);
  if(!sessaoIniciada){
    sessaoIniciada = (async () => {
      try{
        usuarioAtual = await chamar('GET', 'api/auth/eu');
        guardarUsuarioLocal(usuarioAtual);
      }catch(e){
        // sem conexão: abre com o último usuário conhecido (os dados vêm da cópia do aparelho)
        usuarioAtual = e.rede ? lerUsuarioLocal() : null;
        if(!e.rede) guardarUsuarioLocal(null);
      }
    })();
  }
  sessaoIniciada.then(() => { if(ouvintesAuth.has(cb)) cb(usuarioAtual); });
  return () => ouvintesAuth.delete(cb);
}

export async function signInWithEmailAndPassword(_auth, email, senha){
  const u = await chamar('POST', 'api/auth/entrar', { email, senha });
  definirUsuario(u);
  return { user: u };
}
export async function createUserWithEmailAndPassword(_auth, email, senha){
  const u = await chamar('POST', 'api/auth/cadastro', { email, senha });
  definirUsuario(u);
  return { user: u };
}
export async function signOut(_auth){
  try{ await chamar('POST', 'api/auth/sair', {}); }catch(e){ /* sem conexão: sai só deste aparelho */ }
  esquecerTudo();
  definirUsuario(null);
}

// ------------------------------------------------------------ referências (doc / collection)
// Caminhos aqui são relativos ao usuário logado: '' = documento do usuário,
// 'tarefas' = coleção, 'tarefas/abc' = documento. O trecho "usuarios/<uid>" que o app
// ainda escreve é descartado (o servidor decide o uid pelo login, não pelo que o app diz).
function caminhoRelativo(segmentos){
  const s = segmentos.join('/').split('/').filter(Boolean);
  if(s[0] === 'usuarios') s.splice(0, 2);
  return s.join('/');
}
export function collection(_db, ...segmentos){
  return { tipo: 'colecao', path: caminhoRelativo(segmentos) };
}
export function doc(base, ...segmentos){
  if(base && base.tipo === 'colecao') return { tipo: 'doc', path: base.path + '/' + segmentos.join('/') };
  return { tipo: 'doc', path: caminhoRelativo(segmentos) };
}
function partesDoCaminho(path){
  if(path === '') return { col: '', id: '' };
  const i = path.indexOf('/');
  if(i < 0) return { col: path, id: '' }; // referência de coleção ('tarefas')
  return { col: path.slice(0, i), id: path.slice(i + 1) };
}

// ------------------------------------------------------------ estado local por coleção
// col -> { docs: Map(id -> dados), ouvintes: Set, carregado, daCache, assinatura }
const colecoes = new Map();
function estadoDa(col){
  if(!colecoes.has(col)) colecoes.set(col, { docs: new Map(), ouvintes: new Set(), carregado: false, daCache: false, assinatura: null });
  return colecoes.get(col);
}
const clonar = x => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

function chaveCache(col){ return PREFIXO_CACHE + (usuarioAtual ? usuarioAtual.uid : '?') + '.' + (col || '_usuario'); }
function lerCache(col){
  try{ return JSON.parse(localStorage.getItem(chaveCache(col))); }catch(e){ return null; }
}
function gravarCache(col, docs){
  try{ localStorage.setItem(chaveCache(col), JSON.stringify([...docs.entries()])); }catch(e){}
}
function esquecerTudo(){
  colecoes.forEach(e => { e.ouvintes.clear(); });
  colecoes.clear();
  fila = []; salvarFila();
  try{
    Object.keys(localStorage).filter(k => k.startsWith(PREFIXO_CACHE)).forEach(k => localStorage.removeItem(k));
  }catch(e){}
  fecharFluxo();
}

// ------------------------------------------------------------ fila de gravação
const LS_FILA = 'rotina.fila';
let fila = lerFila();          // [{ id, ops: [{tipo, path, data?, merge?}] }]
let enviando = false;
let esperaMs = 0;
const promessas = new Map();   // id -> { ok, erro } (só para itens criados nesta aba)

function lerFila(){ try{ return JSON.parse(localStorage.getItem(LS_FILA)) || []; }catch(e){ return []; } }
function salvarFila(){ try{ localStorage.setItem(LS_FILA, JSON.stringify(fila)); }catch(e){} }

function colecoesDe(ops){ return new Set(ops.map(o => partesDoCaminho(o.path).col)); }
function temPendencia(col){ return fila.some(item => item.ops.some(o => partesDoCaminho(o.path).col === col)); }

// aplica uma operação no estado local (é o que faz a tela mudar antes do servidor responder)
function aplicarLocal(estado, op){
  const { id } = partesDoCaminho(op.path);
  if(op.tipo === 'delete') estado.docs.delete(id);
  else if(op.merge) estado.docs.set(id, { ...(estado.docs.get(id) || {}), ...clonar(op.data) });
  else estado.docs.set(id, clonar(op.data));
}

function enfileirar(ops){
  const item = { id: Date.now() + '-' + Math.random().toString(36).slice(2), ops: clonar(ops) };
  const p = new Promise((ok, erro) => promessas.set(item.id, { ok, erro }));
  fila.push(item);
  salvarFila();
  for(const op of item.ops){
    const { col } = partesDoCaminho(op.path);
    const e = colecoes.get(col);
    if(e && e.carregado) aplicarLocal(e, op);
  }
  colecoesDe(item.ops).forEach(col => { const e = colecoes.get(col); if(e) emitir(e, col); });
  processarFila();
  return p;
}

async function processarFila(){
  if(enviando) return;
  enviando = true;
  while(fila.length){
    const item = fila[0];
    try{
      await chamar('POST', 'api/ops', { ops: item.ops });
      esperaMs = 0;
    }catch(e){
      if(e.rede || e.status === 401 || e.status >= 500){
        // sem conexão (ou servidor com problema): tenta de novo daqui a pouco, sem perder nada
        esperaMs = Math.min((esperaMs || 1000) * 2, 30000);
        enviando = false;
        setTimeout(processarFila, esperaMs);
        colecoesDe(item.ops).forEach(col => { const est = colecoes.get(col); if(est) emitir(est, col); });
        return;
      }
      // erro do pedido em si (dados inválidos): descarta este item e avisa quem gravou
      console.error('Servidor recusou a gravação', e);
      fila.shift(); salvarFila();
      const pr = promessas.get(item.id); promessas.delete(item.id);
      if(pr) pr.erro(e);
      colecoes.forEach((est, col) => { if(colecoesDe(item.ops).has(col)) buscar(col); });
      continue;
    }
    fila.shift(); salvarFila();
    const pr = promessas.get(item.id); promessas.delete(item.id);
    if(pr) pr.ok();
    colecoesDe(item.ops).forEach(col => { const est = colecoes.get(col); if(est) emitir(est, col); });
  }
  enviando = false;
}
window.addEventListener('online', () => { esperaMs = 0; processarFila(); refazerTudo(); });

// ------------------------------------------------------------ gravar / ler
export function setDoc(ref, data, opcoes){
  return enfileirar([{ tipo: 'set', path: ref.path, data, merge: !!(opcoes && opcoes.merge) }]);
}
export function updateDoc(ref, data){
  return enfileirar([{ tipo: 'set', path: ref.path, data, merge: true }]);
}
export function deleteDoc(ref){
  return enfileirar([{ tipo: 'delete', path: ref.path }]);
}
export function writeBatch(_db){
  const ops = [];
  return {
    set(ref, data, opcoes){ ops.push({ tipo: 'set', path: ref.path, data, merge: !!(opcoes && opcoes.merge) }); return this; },
    delete(ref){ ops.push({ tipo: 'delete', path: ref.path }); return this; },
    commit(){ return ops.length ? enfileirar(ops) : Promise.resolve(); }
  };
}
export function getDoc(ref){
  const { col, id } = partesDoCaminho(ref.path);
  return chamar('GET', 'api/docs?col=' + encodeURIComponent(col)).then(r => {
    const achado = r.docs.find(d => d.id === id);
    return { id, exists: () => !!achado, data: () => (achado ? clonar(achado.data) : undefined) };
  });
}

// ------------------------------------------------------------ ouvir (onSnapshot)
function montarSnapshot(estado, col, ouvinte){
  const metadata = { hasPendingWrites: temPendencia(col), fromCache: estado.daCache };
  if(ouvinte.ref.tipo === 'doc'){
    const { id } = partesDoCaminho(ouvinte.ref.path);
    const dados = estado.docs.get(id);
    return { id, metadata, exists: () => dados !== undefined, data: () => clonar(dados) };
  }
  const docs = [...estado.docs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([id, dados]) => ({
    id, metadata, exists: () => true, data: () => clonar(dados)
  }));
  return { docs, metadata, size: docs.length, empty: docs.length === 0, forEach: f => docs.forEach(f) };
}

// Entrega o estado atual a quem está ouvindo — só se algo mudou desde a última entrega
function emitir(estado, col, forcar){
  if(!estado.carregado) return;
  const assinatura = JSON.stringify([...estado.docs.entries()]) + '|' + temPendencia(col) + '|' + estado.daCache;
  if(!forcar && assinatura === estado.assinatura) return;
  estado.assinatura = assinatura;
  estado.ouvintes.forEach(o => { try{ o.aoReceber(montarSnapshot(estado, col, o)); }catch(e){ console.error(e); } });
}

async function buscar(col){
  const estado = colecoes.get(col);
  if(!estado) return;
  try{
    const r = await chamar('GET', 'api/docs?col=' + encodeURIComponent(col));
    const doServidor = new Map(r.docs.map(d => [d.id, d.data]));
    gravarCache(col, doServidor);
    // o que ainda está na fila (não confirmado) vale por cima do que o servidor mandou
    estado.docs = doServidor;
    fila.forEach(item => item.ops.forEach(op => { if(partesDoCaminho(op.path).col === col) aplicarLocal(estado, op); }));
    estado.carregado = true;
    estado.daCache = false;
    emitir(estado, col);
  }catch(e){
    if(e.rede) return; // sem conexão: continua mostrando a cópia do aparelho
    estado.ouvintes.forEach(o => { if(o.aoErro) o.aoErro(e); });
  }
}

export function onSnapshot(ref, a, b, c){
  // formatos aceitos: (ref, aoReceber, aoErro) ou (ref, opcoes, aoReceber, aoErro)
  const aoReceber = typeof a === 'function' ? a : b;
  const aoErro = typeof a === 'function' ? b : c;
  const col = partesDoCaminho(ref.path).col;
  const estado = estadoDa(col);
  const ouvinte = { ref, aoReceber, aoErro };
  estado.ouvintes.add(ouvinte);
  abrirFluxo();

  if(estado.carregado){
    Promise.resolve().then(() => { if(estado.ouvintes.has(ouvinte)) aoReceber(montarSnapshot(estado, col, ouvinte)); });
  }else{
    const guardado = lerCache(col);
    if(guardado){
      estado.docs = new Map(guardado);
      fila.forEach(item => item.ops.forEach(op => { if(partesDoCaminho(op.path).col === col) aplicarLocal(estado, op); }));
      estado.carregado = true;
      estado.daCache = true;
      Promise.resolve().then(() => emitir(estado, col, true));
    }
    buscar(col);
  }
  return () => {
    estado.ouvintes.delete(ouvinte);
    if(estado.ouvintes.size === 0) estado.carregado = false; // próxima vez busca de novo
    if(![...colecoes.values()].some(e => e.ouvintes.size > 0)) fecharFluxo();
  };
}

// ------------------------------------------------------------ tempo real (SSE)
let fluxo = null;
function abrirFluxo(){
  if(fluxo || typeof EventSource === 'undefined') return;
  fluxo = new EventSource('api/fluxo');
  fluxo.onmessage = (ev) => {
    try{
      const { col } = JSON.parse(ev.data);
      if(colecoes.has(col)) buscar(col);
    }catch(e){}
  };
  // ao reconectar (depois de uma queda), confere tudo: pode ter mudado coisa nesse meio-tempo
  fluxo.onopen = () => refazerTudo();
}
function fecharFluxo(){
  if(fluxo){ fluxo.close(); fluxo = null; }
}
function refazerTudo(){
  colecoes.forEach((e, col) => { if(e.ouvintes.size > 0) buscar(col); });
}
// celular que voltou do bloqueio de tela costuma ter perdido avisos do fluxo
document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible') refazerTudo(); });

// guarda-fila: se ficou algo na fila de uma sessão anterior, tenta enviar
if(fila.length) setTimeout(processarFila, 1500);
