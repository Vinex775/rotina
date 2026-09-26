// notifications.js
// Tudo relacionado a pedir permissão e ativar notificações push do usuário.
import { db, messaging, VAPID_KEY } from './firebase-init.js';
import {
  doc, updateDoc, arrayUnion
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';
import { getToken } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-messaging.js';
import { currentUser } from './estado.js';

// O service worker precisa estar registrado pra notificação funcionar mesmo
// com o Rotina fechado. Caminho relativo pra funcionar tanto num domínio
// próprio quanto num projeto do GitHub Pages (usuario.github.io/repo/).
// Guardamos a Promise do registro pra usar esse MESMO registro no getToken()
// mais abaixo — sem isso, o Firebase tenta criar um registro próprio na raiz
// do domínio (e não dentro da subpasta do projeto), o que dá 404.
let swRegistrationPromise = null;
if ('serviceWorker' in navigator) {
  swRegistrationPromise = navigator.serviceWorker.register('./firebase-messaging-sw.js').catch((e) => {
    console.error('Falha ao registrar o service worker de notificações', e);
    return null;
  });
}

export async function ativarNotificacoes() {
  if (!currentUser) return;

  const permissao = await Notification.requestPermission();
  if (permissao !== 'granted') {
    alert('Notificações não foram permitidas pelo navegador.');
    return;
  }

  try {
    const registration = swRegistrationPromise ? await swRegistrationPromise : null;
    const token = await getToken(messaging, {
      vapidKey: VAPID_KEY,
      serviceWorkerRegistration: registration || undefined
    });
    if (!token) {
      alert('Não foi possível gerar o token de notificação.');
      return;
    }
    await updateDoc(doc(db, 'usuarios', currentUser.uid), {
      tokensNotificacao: arrayUnion(token)
    });
    alert('Notificações ativadas com sucesso!');
  } catch (e) {
    console.error('Falha ao ativar notificações', e);
    alert('Algo deu errado ao ativar as notificações. Veja o console para detalhes.');
  }
}
