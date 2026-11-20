// sw.js — "Service Worker": script que roda em segundo plano no navegador, mesmo com a
// aba do Rotina fechada. É ele quem recebe a notificação do servidor e a mostra na tela.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// O servidor manda um pacotinho JSON: { title, body, tag }.
// Duas notificações com o mesmo "tag" se substituem em vez de aparecerem as duas.
self.addEventListener('push', (event) => {
  let dados = {};
  try {
    dados = event.data ? event.data.json() : {};
  } catch (e) {
    dados = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(dados.title || 'Rotina', {
      body: dados.body || 'Você tem um aviso do Rotina.',
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      tag: dados.tag || undefined
    })
  );
});

// Tocar na notificação: abre o Rotina (ou volta para a aba que já está aberta).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((abas) => {
      for (const aba of abas) {
        if ('focus' in aba) return aba.focus();
      }
      return self.clients.openWindow('./');
    })
  );
});
