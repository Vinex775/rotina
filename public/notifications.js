// notifications.js
// Pedir permissão e ativar as notificações (Web Push) neste aparelho.
// O navegador cria uma "inscrição" (endereço próprio do aparelho no serviço de push dele);
// mandamos essa inscrição para o servidor do Rotina, que usa o endereço para avisar.
import { currentUser } from './estado.js';

// O service worker precisa estar registrado para a notificação aparecer mesmo com o
// Rotina fechado. Caminho relativo: funciona em qualquer endereço onde o Rotina esteja.
let swRegistrationPromise = null;
if ('serviceWorker' in navigator) {
  swRegistrationPromise = navigator.serviceWorker.register('./sw.js').catch((e) => {
    console.error('Falha ao registrar o service worker de notificações', e);
    return null;
  });
}

// A chave pública do servidor vem em base64; o navegador quer em bytes
function chaveParaBytes(base64) {
  const preenchida = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const bruto = atob(preenchida);
  return Uint8Array.from(bruto, (c) => c.charCodeAt(0));
}

async function postar(url, corpo) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(corpo)
  });
  if (!r.ok) throw new Error('o servidor respondeu ' + r.status);
  return r.json();
}

export async function ativarNotificacoes() {
  if (!currentUser) return;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    alert('Este navegador não suporta notificações push. (No iPhone, instale o Rotina na tela de início primeiro.)');
    return;
  }

  const permissao = await Notification.requestPermission();
  if (permissao !== 'granted') {
    alert('Notificações não foram permitidas pelo navegador.');
    return;
  }

  try {
    const registro = swRegistrationPromise ? await swRegistrationPromise : null;
    if (!registro) {
      alert('Não foi possível ativar o service worker neste navegador.');
      return;
    }
    await navigator.serviceWorker.ready;

    const r = await fetch('api/push/chave', { credentials: 'same-origin' });
    if (!r.ok) throw new Error('não consegui pegar a chave do servidor (' + r.status + ')');
    const { chave } = await r.json();

    let inscricao = await registro.pushManager.getSubscription();
    if (!inscricao) {
      inscricao = await registro.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: chaveParaBytes(chave) });
    }
    let resp;
    try {
      resp = await postar('api/push/inscrever', { inscricao: inscricao.toJSON() });
    } catch (e) {
      throw e;
    }
    // O servidor manda uma notificação de teste logo em seguida
    alert(resp.teste
      ? 'Notificações ativadas! Você deve receber um aviso de teste agora.'
      : 'Notificações ativadas, mas o aviso de teste não saiu. Veja o registro do servidor.');
  } catch (e) {
    // Inscrição antiga feita com outra chave (ex.: o servidor foi refeito): cancela e tenta de novo
    if (e && e.name === 'InvalidStateError') {
      try {
        const registro = await swRegistrationPromise;
        const velha = await registro.pushManager.getSubscription();
        if (velha) await velha.unsubscribe();
        alert('Havia uma inscrição antiga neste aparelho. Toque em "Notificações" de novo para refazer.');
        return;
      } catch (e2) { /* cai no alerta abaixo */ }
    }
    console.error('Falha ao ativar notificações', e);
    alert('Algo deu errado ao ativar as notificações. Veja o console para detalhes.');
  }
}
