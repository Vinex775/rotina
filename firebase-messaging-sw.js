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

// Isso é chamado quando chega uma notificação e o app está em segundo plano
messaging.onBackgroundMessage((payload) => {
  const { title, body } = payload.notification || {};
  self.registration.showNotification(title || "Rotina", {
    body: body || "Você tem uma tarefa pendente.",
    icon: "/icone-rotina.png", // troque pelo ícone que preferir, se tiver
  });
});
