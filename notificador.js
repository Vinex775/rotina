// notificador.js
// A "cabeça" dos avisos: dado o momento atual, os blocos da Grade e os eventos do
// Calendário, devolve quais notificações devem sair AGORA. Não envia nada nem toca no
// banco — só calcula (por isso dá pra testar com datas falsas). Quem envia é o server.js.
//
// Regras (as mesmas que o Worker do Cloudflare seguia):
//  • Bloco da Grade: campo "avisoAntes", em minutos: 0 = no horário,
//    -1 = sem aviso, ausente = 10 min. Avisa uma vez por dia em que o bloco acontece.
//  • Evento do Calendário: "N dias antes às HH:MM" (avisoDias + avisoHora) ou
//    "X min antes do horário" (avisoMinutos, só se o evento tem horário). Eventos de
//    vários dias avisam pelo primeiro dia. Repetição: nenhuma | mensal | anual.
//
// Cada aviso tem uma "chave" única. O server guarda as chaves já enviadas numa tabela
// própria; se você mudar horário/aviso, a chave muda e ele pode avisar de novo.

const AVISO_PADRAO_MIN = 10;
const AVISO_MAXIMO_MIN = 720;
const EVENTO_AVISO_DIAS_MAX = 60;
const EVENTO_AVISO_MIN_MAX = 720;
const EVENTO_AVISO_HORA_PADRAO = '09:00';

// Por quanto tempo depois da hora certa ainda vale avisar (se o servidor estava
// desligado ou ocupado na hora exata). Depois disso o aviso é considerado perdido,
// para não chegar uma notificação velha horas depois.
const JANELA_MIN = 15;
const JANELA_DIAS_MIN = 60;

const pad = n => String(n).padStart(2, '0');

// "2026-11-19" a partir de uma Date no fuso local do servidor
function iso(d){ return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

// Date (meia-noite local) a partir de "YYYY-MM-DD"
function dataDeIso(s){
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if(!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function somarDias(d, n){ return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }

// Date local a partir de um dia (Date) e "HH:MM"
function comHora(dia, hhmm){
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  if(!m) return null;
  return new Date(dia.getFullYear(), dia.getMonth(), dia.getDate(), Number(m[1]), Number(m[2]), 0, 0);
}

function ultimoDiaDoMes(ano, mes0){ return new Date(ano, mes0 + 1, 0).getDate(); }

function formatarMin(min){
  if(min < 60) return min + ' min';
  const h = Math.floor(min / 60), r = min % 60;
  return r ? (h + ' h ' + r + ' min') : (h + ' h');
}

function avisoDoBloco(bloco){
  const v = bloco && bloco.avisoAntes;
  if(v === -1) return -1;
  return (Number.isInteger(v) && v >= 0) ? Math.min(v, AVISO_MAXIMO_MIN) : AVISO_PADRAO_MIN;
}

function avisoDoEvento(ev){
  if(ev && ev.horario && Number.isInteger(ev.avisoMinutos) && ev.avisoMinutos >= 0){
    return { tipo: 'min', minutos: Math.min(ev.avisoMinutos, EVENTO_AVISO_MIN_MAX) };
  }
  if(ev && Number.isInteger(ev.avisoDias) && ev.avisoDias >= 0){
    const hora = /^\d{2}:\d{2}$/.test(ev.avisoHora || '') ? ev.avisoHora : EVENTO_AVISO_HORA_PADRAO;
    return { tipo: 'dias', dias: Math.min(ev.avisoDias, EVENTO_AVISO_DIAS_MAX), hora };
  }
  return { tipo: 'nenhum' };
}

// O evento começa (uma ocorrência) neste dia?
function ocorreNoDia(ev, dia){
  const ini = dataDeIso(ev.dataInicio);
  if(!ini || dia < ini) return false;
  const rec = ev.recorrencia || 'nenhuma';
  if(rec === 'nenhuma') return iso(dia) === ev.dataInicio;
  if(rec === 'mensal'){
    const alvo = Math.min(ini.getDate(), ultimoDiaDoMes(dia.getFullYear(), dia.getMonth()));
    return dia.getDate() === alvo;
  }
  if(rec === 'anual'){
    if(dia.getMonth() !== ini.getMonth()) return false;
    const alvo = Math.min(ini.getDate(), ultimoDiaDoMes(dia.getFullYear(), dia.getMonth()));
    return dia.getDate() === alvo;
  }
  return false;
}

function dentroDaJanela(agora, quando, janelaMin){
  const t = quando.getTime(), a = agora.getTime();
  return a >= t && a < t + janelaMin * 60000;
}

// Devolve [{ chave, tag, titulo, corpo }]
function calcularAvisos(agora, blocos, eventos){
  const saida = [];
  const hoje = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate());

  // ---- Grade ----
  // olha ontem/hoje/amanhã: um bloco às 00:05 com aviso de 10 min avisa às 23:55 de ontem
  for(const bloco of (blocos || [])){
    const aviso = avisoDoBloco(bloco);
    if(aviso < 0 || !bloco.id) continue;
    for(const desloc of [-1, 0, 1]){
      const dia = somarDias(hoje, desloc);
      if(Number(bloco.dia) !== dia.getDay()) continue;
      const inicio = comHora(dia, bloco.inicio);
      if(!inicio) continue;
      const disparo = new Date(inicio.getTime() - aviso * 60000);
      if(!dentroDaJanela(agora, disparo, JANELA_MIN)) continue;
      const quando = aviso === 0 ? 'agora' : ('daqui a ' + formatarMin(aviso));
      saida.push({
        chave: 'b|' + bloco.id + '|' + iso(dia) + '|' + bloco.inicio + '|' + aviso,
        tag: 'bloco-' + bloco.id,
        titulo: 'Rotina',
        corpo: bloco.inicio + ' (' + quando + '): ' + (bloco.texto || 'bloco da grade')
      });
    }
  }

  // ---- Calendário ----
  for(const ev of (eventos || [])){
    const aviso = avisoDoEvento(ev);
    if(aviso.tipo === 'nenhum' || !ev.id || !dataDeIso(ev.dataInicio)) continue;
    const titulo = ev.titulo || 'Evento';

    if(aviso.tipo === 'dias'){
      // dia em que o aviso SAI: ontem ou hoje (cobre aviso das 23:50 perto da meia-noite)
      for(const desloc of [-1, 0]){
        const diaAviso = somarDias(hoje, desloc);
        const diaEvento = somarDias(diaAviso, aviso.dias);
        if(!ocorreNoDia(ev, diaEvento)) continue;
        if(ev.avisoAte && iso(diaAviso) > ev.avisoAte) continue;
        const disparo = comHora(diaAviso, aviso.hora);
        if(!disparo || !dentroDaJanela(agora, disparo, JANELA_DIAS_MIN)) continue;
        const quando = aviso.dias === 0 ? 'hoje' : aviso.dias === 1 ? 'amanhã' : ('daqui a ' + aviso.dias + ' dias');
        const dm = pad(diaEvento.getDate()) + '/' + pad(diaEvento.getMonth() + 1);
        saida.push({
          chave: 'e|' + ev.id + '|' + iso(diaEvento) + '|dias' + aviso.dias + '|' + aviso.hora,
          tag: 'evento-' + ev.id,
          titulo: titulo,
          corpo: quando + ', ' + dm + (ev.horario ? ' às ' + ev.horario : '')
        });
      }
    } else {
      for(const desloc of [-1, 0, 1]){
        const diaEvento = somarDias(hoje, desloc);
        if(!ocorreNoDia(ev, diaEvento)) continue;
        const inicio = comHora(diaEvento, ev.horario);
        if(!inicio) continue;
        const disparo = new Date(inicio.getTime() - aviso.minutos * 60000);
        if(!dentroDaJanela(agora, disparo, JANELA_MIN)) continue;
        const quando = aviso.minutos === 0 ? 'agora' : ('daqui a ' + formatarMin(aviso.minutos));
        saida.push({
          chave: 'e|' + ev.id + '|' + iso(diaEvento) + '|min' + aviso.minutos + '|' + ev.horario,
          tag: 'evento-' + ev.id,
          titulo: titulo,
          corpo: ev.horario + ' (' + quando + ')'
        });
      }
    }
  }
  return saida;
}

module.exports = { calcularAvisos, avisoDoBloco, avisoDoEvento, ocorreNoDia, iso };
