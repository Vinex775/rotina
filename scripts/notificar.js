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
const MINUTOS_APOS_O_INICIO = 30;     // e ainda avisa se começou há até 30 min

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

// Igual à de cima, mas sabendo que o bloco pode cair em outro dia:
// deslocamento = -1 (ontem), 0 (hoje) ou +1 (amanhã). Assim um bloco às 00:05
// já pode ser avisado às 23:55, e um bloco às 23:50 ainda às 00:10.
function minutosAteOBloco(inicio, agoraMin, deslocamento) {
  const inicioMin = paraMinutos(inicio);
  if (inicioMin === null) return null;
  return deslocamento * 24 * 60 + inicioMin - agoraMin;
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
    // Set tira tokens repetidos (o mesmo aparelho cadastrado duas vezes)
    const tokens = [...new Set(usuarioDoc.data().tokensNotificacao || [])];
    if (tokens.length === 0) continue; // ninguém pra notificar aqui

    // Blocos de ontem, hoje e amanhã (o campo "dia" é o dia da semana do
    // bloco). Olhar os três é o que permite avisar certo na virada da meia-noite.
    const diasRelevantes = [-1, 0, 1].map((o) => (diaDaSemana + o + 7) % 7);
    const blocosSnap = await usuarioDoc.ref
      .collection("blocos")
      .where("dia", "in", diasRelevantes)
      .get();

    for (const blocoDoc of blocosSnap.docs) {
      const bloco = blocoDoc.data();

      // Este bloco cai ontem (-1), hoje (0) ou amanhã (+1) em relação a agora?
      const deslocamento = [-1, 0, 1].find((o) => (diaDaSemana + o + 7) % 7 === bloco.dia);
      if (deslocamento === undefined) continue;

      const diferenca = minutosAteOBloco(bloco.inicio, agoraMin, deslocamento);
      if (!estaNaJanela(diferenca)) continue;

      // Data real em que este bloco acontece (a "chave" que marca o aviso feito)
      const dataDoBloco = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() + deslocamento);
      const chaveDoBloco = dailyKey(dataDoBloco);

      // Já avisamos este bloco neste dia? Então pula (evita repetir entre execuções)
      if (bloco.ultimaNotificacao === chaveDoBloco) continue;

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
          if (tarefaEstaConcluida(tarefa, dataDoBloco)) continue; // já feita, pula
          texto = tarefa.text || texto;
        }
      }

      const corpo = montarCorpo(bloco.inicio, diferenca, texto);

      // RESERVA o aviso ANTES de enviar. Antes o script só gravava
      // "ultimaNotificacao" depois do envio; se duas execuções rodassem ao
      // mesmo tempo, as duas passavam pela checagem acima e as duas enviavam.
      // A transação garante que só UMA execução consiga reservar.
      const reservado = await db.runTransaction(async (t) => {
        const atual = await t.get(blocoDoc.ref);
        if (!atual.exists || atual.data().ultimaNotificacao === chaveDoBloco) return false;
        t.update(blocoDoc.ref, { ultimaNotificacao: chaveDoBloco });
        return true;
      });
      if (!reservado) continue; // outra execução já cuidou deste aviso

      // Se o envio falhar em todos os aparelhos, devolve a reserva pra a
      // próxima execução tentar de novo.
      const liberarReserva = async () => {
        try {
          await blocoDoc.ref.update({
            ultimaNotificacao:
              bloco.ultimaNotificacao !== undefined ? bloco.ultimaNotificacao : FieldValue.delete(),
          });
        } catch (e) {
          console.error("Falha ao liberar a reserva do aviso:", e);
        }
      };

      try {
        // Mensagem só com "data" (sem o campo "notification"): quem mostra a
        // notificação é o firebase-messaging-sw.js, uma única vez.
        // Urgency/priority "high" pedem entrega imediata (o Android costuma
        // segurar avisos comuns quando está economizando bateria) e o TTL
        // descarta o aviso se o aparelho ficar 30 min sem receber, em vez de
        // entregar um "Começa às 10:00" ao meio-dia.
        const resposta = await getMessaging().sendEachForMulticast({
          data: {
            title: "Rotina",
            body: corpo,
            tag: `bloco-${blocoDoc.id}-${chaveDoBloco}`,
          },
          webpush: { headers: { Urgency: "high", TTL: "1800" } },
          android: { priority: "high" },
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

        // O aviso já está reservado (marcado como feito). Se nenhum aparelho
        // recebeu, desfaz a reserva pra a próxima execução tentar de novo.
        if (resposta.successCount > 0) {
          totalEnviadas++;
        } else {
          await liberarReserva();
        }
      } catch (erro) {
        console.error(`Erro ao notificar ${usuarioDoc.id}:`, erro);
        await liberarReserva();
      }
    }
  }

  console.log(`Verificação concluída. Notificações enviadas: ${totalEnviadas}.`);
}

module.exports = {
  paraMinutos, minutosAteOInicio, minutosAteOBloco, estaNaJanela, montarCorpo,
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
