// estado.js
// Pedacinhos de estado compartilhados por mais de uma parte do app.
// Ficam aqui (em vez de dentro de um arquivo só) porque tanto notifications.js
// quanto o próprio index.html precisam ler/mudar o mesmo valor.
//
// Por que uma função "set..." em vez de deixar os outros arquivos mudarem a
// variável direto? Em módulos JavaScript, um arquivo que importa uma
// variável de outro só pode LER o valor — só quem declarou a variável (este
// arquivo) pode reatribuir ela. Por isso o jeito de "avisar" uma mudança pra
// cá é chamando uma função exportada, em vez de fazer "currentUser = ..."
// de fora.
export let currentUser = null;
export function setCurrentUser(user){
  currentUser = user;
}
