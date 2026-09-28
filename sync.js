// sync.js
// O "motor" de sincronização com o Firestore: referências das coleções,
// salvar o modo (meio período/integral), migrar contas antigas, e
// começar/parar de escutar tudo em tempo real.
//
// Esse arquivo ainda não conhece tasks.js/grade.js/calendario.js (que só vão
// existir numa próxima etapa da separação) — então, em vez de importar
// render()/renderGrade()/setTasks()/etc. diretamente (o que criaria um ciclo
// de import com o index.html), o index.html PASSA essas funções pra cá na
// hora de chamar comecarAEscutarDados, dentro de um objeto "acoes". É como
// avisar por telefone: este arquivo não precisa saber onde a função mora,
// só precisa chamar o número (a função) que foi passado.

import {
  doc, setDoc, getDoc, deleteDoc, collection, writeBatch, onSnapshot
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';
import { db } from './firebase-init.js';
import { currentUser, telaAtual } from './estado.js';

export function tarefasColRef(){
  return collection(db, 'usuarios', currentUser.uid, 'tarefas');
}

export function blocosColRef(){
  return collection(db, 'usuarios', currentUser.uid, 'blocos');
}

export function eventosColRef(){
  return collection(db, 'usuarios', currentUser.uid, 'eventos');
}

export function usuarioDocRef(){
  return doc(db, 'usuarios', currentUser.uid);
}

// Evita salvar de volta no Firestore enquanto estamos só RECEBENDO dados de
// lá (senão viraria um loop: recebe -> salva -> recebe de novo -> ...).
// Só este arquivo muda o valor — quem importa, só lê.
export let isApplyingRemoteData = false;

export async function salvarModo(modo){
  if(!currentUser || isApplyingRemoteData) return;
  try{
    await setDoc(usuarioDocRef(), { mode: modo }, { merge: true });
  }catch(e){
    console.error('Falha ao salvar modo', e);
  }
}

// Migração de contas antigas: se o documento do usuário ainda tiver
// aquele campo "tasks" (array inteiro, do jeito antigo), transforma
// cada item dele num documento separado na nova coleção, uma única vez.
// É seguro rodar isso de novo por engano — usa o mesmo id de sempre,
// então só sobrescreve com o mesmo conteúdo, nunca duplica.
export async function migrarDadosAntigosSeNecessario(){
  const refUsuario = usuarioDocRef();
  const snap = await getDoc(refUsuario);
  const data = snap.data();
  if(!data || !Array.isArray(data.tasks) || data.tasks.length === 0) return;

  const batch = writeBatch(db);
  data.tasks.forEach((t, i) => {
    const id = t.id || ('t' + Date.now() + i);
    const tarefaComOrdem = { ...t, id, ordem: (t.ordem != null ? t.ordem : i) };
    batch.set(doc(tarefasColRef(), id), tarefaComOrdem);
  });
  // sobrescreve o documento do usuário SEM o campo "tasks" antigo — a partir
  // de agora ele só guarda o modo, as tarefas vivem todas na subcoleção
  batch.set(refUsuario, { mode: data.mode || 'ambos' });
  await batch.commit();
}

let pendingWritesModo = false;
let pendingWritesTarefas = false;
let pendingWrites = false;

function atualizarStatusSincronizacao(){
  pendingWrites = pendingWritesModo || pendingWritesTarefas;
  document.getElementById('syncStatus').textContent = pendingWrites ? 'salvando...' : 'sincronizado';
}

// Se você tentar fechar/recarregar a aba enquanto ainda existe alteração
// não confirmada pelo servidor, o navegador mostra um aviso de confirmação.
window.addEventListener('beforeunload', (e) => {
  if(pendingWrites){
    e.preventDefault();
    e.returnValue = '';
  }
});

let unsubscribeModo = null;
let unsubscribeTarefas = null;
let unsubscribeBlocos = null;
let unsubscribeEventos = null;

// 'acoes' é um objeto com as funções que este arquivo precisa chamar, mas que
// ainda moram no index.html: setTasks, setBlocos, setEventos, setCurrentMode,
// render, renderGrade, renderCalendario, checkMissedTasks, cleanupOnceTasks,
// resetExpiredPipelines, salvarVariasTarefas.
export function comecarAEscutarDados(acoes){
  unsubscribeModo = onSnapshot(usuarioDocRef(), { includeMetadataChanges: true }, (snap) => {
    pendingWritesModo = snap.metadata.hasPendingWrites;
    const data = snap.data();
    acoes.setCurrentMode((data && data.mode) || 'ambos');
    atualizarStatusSincronizacao();
    acoes.render();
  }, (err) => {
    console.error('Erro ao escutar modo', err);
    document.getElementById('syncStatus').textContent = 'sem conexão';
  });

  unsubscribeTarefas = onSnapshot(tarefasColRef(), { includeMetadataChanges: true }, (snap) => {
    pendingWritesTarefas = snap.metadata.hasPendingWrites;

    isApplyingRemoteData = true;
    const listaTarefas = snap.docs.map(d => ({ ...d.data(), id: d.id }));
    listaTarefas.sort((a, b) => (a.ordem || 0) - (b.ordem || 0));
    acoes.setTasks(listaTarefas);

    document.getElementById('loadingMsg').style.display = 'none';
    atualizarStatusSincronizacao();

    const tarefasComAtraso = acoes.checkMissedTasks();
    const idsParaApagar = acoes.cleanupOnceTasks();
    const tarefasComPipelineResetado = acoes.resetExpiredPipelines();

    acoes.render();
    isApplyingRemoteData = false;

    // junta as duas listas de "tarefas alteradas pela manutenção" sem duplicar,
    // caso a mesma tarefa apareça em ambas
    const mapaTarefasAlteradas = new Map();
    tarefasComAtraso.forEach(t => mapaTarefasAlteradas.set(t.id, t));
    tarefasComPipelineResetado.forEach(t => mapaTarefasAlteradas.set(t.id, t));
    acoes.salvarVariasTarefas(Array.from(mapaTarefasAlteradas.values()), idsParaApagar);
  }, (err) => {
    console.error('Erro ao escutar tarefas', err);
    document.getElementById('syncStatus').textContent = 'sem conexão';
  });

  unsubscribeBlocos = onSnapshot(blocosColRef(), (snap) => {
    acoes.setBlocos(snap.docs.map(d => ({ ...d.data(), id: d.id })));
    if(telaAtual === 'grade') acoes.renderGrade();
  }, (err) => {
    console.error('Erro ao escutar blocos da grade', err);
  });

  unsubscribeEventos = onSnapshot(eventosColRef(), (snap) => {
    acoes.setEventos(snap.docs.map(d => ({ ...d.data(), id: d.id })));
    if(telaAtual === 'calendario') acoes.renderCalendario();
  }, (err) => {
    console.error('Erro ao escutar eventos do calendário', err);
  });
}

export function pararDeEscutar(){
  if(unsubscribeModo){ unsubscribeModo(); unsubscribeModo = null; }
  if(unsubscribeTarefas){ unsubscribeTarefas(); unsubscribeTarefas = null; }
  if(unsubscribeBlocos){ unsubscribeBlocos(); unsubscribeBlocos = null; }
  if(unsubscribeEventos){ unsubscribeEventos(); unsubscribeEventos = null; }
}
