// firebase-init.js
// Ponto único de inicialização do Firebase. Qualquer outro arquivo que
// precise falar com o Firebase (auth.js, sync.js, tasks.js, grade.js,
// calendario.js, notifications.js) importa 'app', 'auth', 'db' ou
// 'messaging' DAQUI, em vez de inicializar o app de novo — senão viraria
// mais de uma conexão concorrendo pelo mesmo projeto.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';
import { getMessaging } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-messaging.js';

// Sua configuração do projeto Firebase (identifica o projeto, não é secreta)
const firebaseConfig = {
  apiKey: "AIzaSyADpeCEevj15AGz-xuhlZvY1xgvuLZyGuU",
  authDomain: "rotina-e87f2.firebaseapp.com",
  projectId: "rotina-e87f2",
  storageBucket: "rotina-e87f2.firebasestorage.app",
  messagingSenderId: "867915295946",
  appId: "1:867915295946:web:e1433e946157e4c3d69833"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Antes: const db = getFirestore(app);
// Agora: guardamos um cache persistente em disco (IndexedDB), não só na
// memória RAM. Isso faz o app enfileirar suas alterações de um jeito que
// sobrevive a fechar a aba, perder internet, ou o PC dormir no meio do
// caminho — quando a conexão voltar, ele reenvia sozinho o que faltou.
// persistentMultipleTabManager() é o que permite abrir o Rotina em mais
// de uma aba ao mesmo tempo sem elas brigarem por causa desse cache.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

// ---------- Notificações push ----------
// Chave gerada em: Firebase Console > Configurações do projeto > Cloud
// Messaging > "Web Push certificates" > Generate key pair. Sem ela, o
// getToken() (usado em notifications.js) não funciona.
export const VAPID_KEY = "BBrcXdHGipIRtVJhkUuNwglGHDvcSGA8KnwYbXKIcQb8bHvotwJcQEFuqhB9emq-W1YDjJPiOK6AGoRpVH4P8tQ";
export const messaging = getMessaging(app);
