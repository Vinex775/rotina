// notificar.js
// Esse é o script que o GitHub Actions vai rodar sozinho, no horário agendado.
// Ele: 1) conecta no Firebase usando a credencial secreta, 2) passa por todos
// os usuários, 3) olha as tarefas de cada um, 4) manda notificação pra quem
// tem tarefa "batendo" com o horário atual.
 
const admin = require("firebase-admin");
 
// A credencial vem de uma variável de ambiente (o secret do GitHub Actions),
// nunca de um arquivo salvo no repositório.
const credenciais = JSON.parse(process.env.FIREBASE_CREDENTIALS);
 
admin.initializeApp({
  credential: admin.credential.cert(credenciais),
});
 
const db = admin.firestore();
 
// Formata a hora atual como "HH:MM" (ajuste o timeZone para o seu, se precisar)
function horaAtual() {
  return new Date().toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Sao_Paulo",
  });
}
 
// --- Réplica das funções de "chave de ciclo" do próprio app (rotina-6_4.html) ---
// Precisamos delas aqui pra saber se uma tarefa vinculada a um bloco já foi
// concluída no ciclo atual (dia/semana/mês), do mesmo jeito que o app faz.
function pad(n) { return String(n).padStart(2, "0"); }
 
function dailyKey(d) {
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}
 
function weeklyKey(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const fDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fDayNum + 3);
  const semana = 1 + Math.round((date - firstThursday) / (7 * 24 * 60 * 60 * 1000));
  return date.getUTCFullYear() + "-W" + pad(semana);
}
 
function monthlyKey(d) {
  return d.getFullYear() + "-" + pad(d.getMonth() + 1);
}
 
function currentKey(freq) {
  const d = new Date();
  if (freq === "daily") return dailyKey(d);
  if (freq === "weekly") return weeklyKey(d);
  if (freq === "monthly") return monthlyKey(d);
  return dailyKey(d); // 'once' cai aqui, igual ao app original
}
 
// Mesma regra do app: com mini-passos, só conta feita se todos os subtasks
// estiverem 'done'; sem mini-passos, compara doneKey com o ciclo atual.
function tarefaEstaConcluida(task) {
  if (task.subtasks && task.subtasks.length > 0) {
    return task.subtasks.every((s) => s.done);
  }
  return task.doneKey === currentKey(task.freq);
}
 
async function main() {
  const agora = horaAtual(); // formato "HH:MM", igual ao <input type="time">
  console.log(`Rodando verificação de blocos às ${agora}`);
 
  const usuariosSnap = await db.collection("usuarios").get();
 
  for (const usuarioDoc of usuariosSnap.docs) {
    const usuario = usuarioDoc.data();
    const tokens = usuario.tokensNotificacao || [];
 
    if (tokens.length === 0) continue; // ninguém pra notificar aqui
 
    // O horário mora nos "blocos" (grade), não nas tarefas
    const blocosSnap = await usuarioDoc.ref
      .collection("blocos")
      .where("inicio", "==", agora)
      .get();
 
    if (blocosSnap.empty) continue;
 
    for (const blocoDoc of blocosSnap.docs) {
      const bloco = blocoDoc.data();
      let corpoMensagem = bloco.texto || "Você tem um bloco começando agora.";
 
      // Se o bloco está vinculado a uma tarefa e ela já foi concluída
      // neste ciclo, não faz sentido notificar de novo
      if (bloco.taskId) {
        const tarefaDoc = await usuarioDoc.ref
          .collection("tarefas")
          .doc(bloco.taskId)
          .get();
 
        if (tarefaDoc.exists) {
          const tarefa = tarefaDoc.data();
          if (tarefaEstaConcluida(tarefa)) continue; // já feita, pula
          corpoMensagem = tarefa.text || corpoMensagem;
        }
      }
 
      const mensagem = {
        notification: {
          title: "Rotina",
          body: corpoMensagem,
        },
        tokens, // manda pra todos os dispositivos desse usuário de uma vez
      };
 
      try {
        const resposta = await admin.messaging().sendEachForMulticast(mensagem);
        console.log(
          `Notificação "${corpoMensagem}" enviada para ${usuarioDoc.id}: ` +
            `${resposta.successCount} sucesso(s), ${resposta.failureCount} falha(s)`
        );
      } catch (erro) {
        console.error(`Erro ao notificar ${usuarioDoc.id}:`, erro);
      }
    }
  }
 
  console.log("Verificação concluída.");
}
 
main().catch((erro) => {
  console.error("Erro geral no script:", erro);
  process.exit(1);
});
 
