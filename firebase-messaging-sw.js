// firebase-messaging-sw.js
// Esse arquivo é o "Service Worker": um script que roda em segundo plano no
// navegador, mesmo com a aba do Rotina fechada. É ele quem recebe a notificação
// push e mostra na tela. O Firebase EXIGE que esse arquivo exista na raiz do
// site (mesmo nível do index.html) com exatamente esse nome.

importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

// Mesma config que você já usa no resto do app (copie do seu firebaseConfig atual)
firebase.initializeApp({
  apiKey: "AIzaSyADpeCEevj15AGz-xuhlZvY1xgvuLZyGuU",
  authDomain: "rotina-e87f2.firebaseapp.com",
  projectId: "rotina-e87f2",
  storageBucket: "rotina-e87f2.firebasestorage.app",
  messagingSenderId: "867915295946",
  appId: "1:867915295946:web:e1433e946157e4c3d69833",
});

const messaging = firebase.messaging();

// Isso é chamado quando chega uma notificação e o app está em segundo plano.
//
// Por que tanta atenção aqui: antes, o servidor mandava a mensagem com o campo
// "notification" (que o próprio navegador já mostra sozinho) E este código
// chamava showNotification de novo — o resultado eram duas notificações.
// Agora o servidor manda só "data" e quem mostra é ESTE código, uma única vez.
messaging.onBackgroundMessage((payload) => {
  // Mensagem antiga, com "notification": o navegador já mostrou. Não repete.
  if (payload.notification) return;

  const data = payload.data || {};
  self.registration.showNotification(data.title || "Rotina", {
    body: data.body || "Você tem uma tarefa pendente.",
    // Caminhos relativos ao service worker, então funcionam em /rotina/ no GitHub Pages
    icon: "icon-192.png",
    // Duas notificações com o mesmo "tag" se substituem em vez de aparecerem as
    // duas (cobre o caso de o mesmo aparelho ter mais de um token cadastrado).
    tag: data.tag || undefined,
  });
});

// Tocar na notificação: abre o Rotina (ou volta para a aba que já está aberta).
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((abas) => {
      for (const aba of abas) {
        if ("focus" in aba) return aba.focus();
      }
      return clients.openWindow("./");
    })
  );
});
