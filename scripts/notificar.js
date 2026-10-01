// notificar.js
// Script que o GitHub Actions roda sozinho, de tempos em tempos.
// Ele: 1) conecta no Firebase com a credencial secreta, 2) passa por todos
// os usuários que ativaram notificações, 3) olha os blocos da Grade Horária
// que começam por volta de agora, no dia da semana de hoje, 4) manda o push
// (uma única vez por bloco por dia).

const FUSO = "America/Sao_Paulo";

// O agendamento do GitHub Actions NÃO roda no minuto exato (costuma atrasar
// alguns minutos), então em vez de exigir "início == agora", avisamos os
// blocos cujo início cai numa JANELA em volta do momento em que o script
// rodou. As janelas de execuções seguidas se sobrepõem de propósito; quem
// evita avisar duas vezes é o campo "ultimaNotificacao" gravado no bloco.
const MINUTOS_ANTES_DO_INICIO = 10;   // avisa até 10 min antes de começar
const MINUTOS_APOS_O_INICIO = 20;     // e ainda avisa se começou há até 20 min

function pad(n) { return String(n).padStart(2, "0"); }

// Devolve um Date cujos campos (getHours, getDate, getDay...) mostram o
// horário do relógio em São Paulo. O servidor do GitHub roda em UTC, então sem isso as
// datas virariam "amanhã" a partir das 21h no Brasil.
function agoraEmSaoPaulo() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: FUSO }));
}

// "HH:MM" -> minutos desde a meia-noite (ou null se o texto for inválido)
function paraMinutos(hhmm) {
  if (typeof hhmm !== "string") return null;
  const partes = hhmm.split(":");
  if (partes.length !== 2) return null;
  const h = Number(partes[0]);
  const m = Number(partes[1]);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  return h * 60 + m;
}

// Diferença em minutos entre o início do bloco e agora
// (positivo = ainda vai começar, negativo = já começou).
// Não trata a virada da meia-noite: um bloco às 00:05 não é avisado às 23:55.
function minutosAteOInicio(inicio, agoraMin) {
  const inicioMin = paraMinutos(inicio);
  if (inicioMin === null) return null;
  return inicioMin - agoraMin;
}

function estaNaJanela(diferenca) {
  if (diferenca === null) return false;
  return diferenca <= MINUTOS_ANTES_DO_INICIO && diferenca >= -MINUTOS_APOS_O_INICIO;
}

// --- Réplica das funções de "chave de ciclo" do próprio app (index.html) ---
// Servem pra saber se uma tarefa vinculada a um bloco já foi concluída no
// ciclo atual (dia/semana/mês), do mesmo jeito que o app decide isso.
// Recebem a data por parâmetro (em vez de chamar new Date() aqui dentro)
// pra usarem a hora de São Paulo.
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

function currentKey(freq, d) {
  if (freq === "daily") return dailyKey(d);
  if (freq === "weekly") return weeklyKey(d);
  if (freq === "monthly") return monthlyKey(d);
  return dailyKey(d); // 'once' cai aqui, igual ao app original
}

// Mesma regra do app: com mini-passos, só conta feita se todos os subtasks
// estiverem 'done'; sem mini-passos, compara doneKey com o ciclo atual.
function tarefaEstaConcluida(task, d) {
  if (task.subtasks && task.subtasks.length > 0) {
    return task.subtasks.every((s) => s.done);
  }
  return task.doneKey === currentKey(task.freq, d);
}

function montarCorpo(inicio, diferenca, texto) {
  return diferenca > 0
    ? `Começa às ${inicio}: ${texto}`
    : `Começou às ${inicio}: ${texto}`;
}

async function main() {
  // Só carrega o firebase-admin aqui dentro pra dar pra testar as funções
  // acima sem precisar da credencial nem da biblioteca instalada.
  // A partir da v10 do firebase-admin, o jeito recomendado é importar só o
  // que se usa de cada "módulo" (app/firestore/messaging), em vez do antigo
  // require("firebase-admin") com tudo pendurado em "admin.*".
  const { initializeApp, cert } = require("firebase-admin/app");
  const { getFirestore, FieldValue } = require("firebase-admin/firestore");
  const { getMessaging } = require("firebase-admin/messaging");

  const credenciais = JSON.parse(process.env.FIREBASE_CREDENTIALS);
  initializeApp({ credential: cert(credenciais) });
  const db = getFirestore();

  const agora = agoraEmSaoPaulo();
  const agoraMin = agora.getHours() * 60 + agora.getMinutes();
  const hoje = dailyKey(agora);
  const diaDaSemana = agora.getDay(); // 0 = domingo ... 6 = sábado, igual ao app

  console.log(
    `Rodando verificação às ${pad(agora.getHours())}:${pad(agora.getMinutes())} ` +
      `(dia da semana ${diaDaSemana}, ${hoje})`
  );

  const usuariosSnap = await db.collection("usuarios").get();
  let totalEnviadas = 0;

  for (const usuarioDoc of usuariosSnap.docs) {
    const tokens = usuarioDoc.data().tokensNotificacao || [];
    if (tokens.length === 0) continue; // ninguém pra notificar aqui

    // Só os blocos de hoje (o campo "dia" é o dia da semana do bloco)
    const blocosSnap = await usuarioDoc.ref
      .collection("blocos")
      .where("dia", "==", diaDaSemana)
      .get();

    for (const blocoDoc of blocosSnap.docs) {
      const bloco = blocoDoc.data();

      const diferenca = minutosAteOInicio(bloco.inicio, agoraMin);
      if (!estaNaJanela(diferenca)) continue;

      // Já avisamos este bloco hoje? Então pula (evita repetir entre execuções)
      if (bloco.ultimaNotificacao === hoje) continue;

      let texto = bloco.texto || "Você tem um bloco na sua grade.";

      // Se o bloco está vinculado a uma tarefa e ela já foi concluída
      // neste ciclo, não faz sentido notificar
      if (bloco.taskId) {
        const tarefaDoc = await usuarioDoc.ref
          .collection("tarefas")
          .doc(bloco.taskId)
          .get();

        if (tarefaDoc.exists) {
          const tarefa = tarefaDoc.data();
          if (tarefaEstaConcluida(tarefa, agora)) continue; // já feita, pula
          texto = tarefa.text || texto;
        }
      }

      const corpo = montarCorpo(bloco.inicio, diferenca, texto);

      try {
        const resposta = await getMessaging().sendEachForMulticast({
          notification: { title: "Rotina", body: corpo },
          tokens, // todos os dispositivos desse usuário de uma vez
        });

        console.log(
          `"${corpo}" -> usuário ${usuarioDoc.id}: ` +
            `${resposta.successCount} sucesso(s), ${resposta.failureCount} falha(s)`
        );

        // Tokens que o Firebase diz que não existem mais (app reinstalado,
        // permissão revogada...) são removidos pra não acumular lixo.
        const invalidos = [];
        resposta.responses.forEach((r, i) => {
          if (
            !r.success &&
            r.error &&
            (r.error.code === "messaging/registration-token-not-registered" ||
              r.error.code === "messaging/invalid-registration-token")
          ) {
            invalidos.push(tokens[i]);
          }
        });
        if (invalidos.length > 0) {
          await usuarioDoc.ref.update({
            tokensNotificacao: FieldValue.arrayRemove(...invalidos),
          });
          console.log(`Removidos ${invalidos.length} token(s) inválido(s).`);
        }

        // Só marca como "avisado hoje" se pelo menos um aparelho recebeu;
        // se falhou em todos, a próxima execução tenta de novo.
        if (resposta.successCount > 0) {
          await blocoDoc.ref.update({ ultimaNotificacao: hoje });
          totalEnviadas++;
        }
      } catch (erro) {
        console.error(`Erro ao notificar ${usuarioDoc.id}:`, erro);
      }
    }
  }

  console.log(`Verificação concluída. Notificações enviadas: ${totalEnviadas}.`);
}

module.exports = {
  paraMinutos, minutosAteOInicio, estaNaJanela, montarCorpo,
  dailyKey, weeklyKey, monthlyKey, currentKey, tarefaEstaConcluida,
};

// Só roda o main() quando o arquivo é executado direto (node scripts/notificar.js),
// não quando é importado por um teste.
if (require.main === module) {
  main().catch((erro) => {
    console.error("Erro geral no script:", erro);
    process.exit(1);
  });
}
