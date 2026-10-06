// voz.js — criar tarefas e eventos do Rotina falando (ou digitando) uma frase.
//
// Duas partes:
//  1) interpretarFrase(): lê uma frase em português ("Acordar bebê às 11:00",
//     "Reunião amanhã às 14h30", "Comprar pão"...) e descobre o título, a data, o
//     horário e se é uma TAREFA ou um EVENTO do calendário. Não depende da tela,
//     então dá pra testar sozinha.
//  2) abrirPainelDeVoz(): o painelzinho que ouve o microfone, mostra o que foi
//     entendido (pra você corrigir se o reconhecimento errou) e cria o item.

const DIAS_SEMANA = [
  { re: 'domingo', n: 0 },
  { re: 'segunda', n: 1 },
  { re: 'ter[çc]a', n: 2 },
  { re: 'quarta', n: 3 },
  { re: 'quinta', n: 4 },
  { re: 'sexta', n: 5 },
  { re: 's[áa]bado', n: 6 }
];
const MESES = [
  'janeiro', 'fevereiro', 'mar[çc]o', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'
];
const MESES_RE = MESES.join('|');
const DIAS_RE = DIAS_SEMANA.map(d => d.re).join('|');

function pad2(n){ return String(n).padStart(2, '0'); }
function paraISO(d){ return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function inicioDoDia(d){ return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function somarDias(d, n){ return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }

function indiceDoMes(nome){
  const n = nome.toLowerCase().replace('ç', 'c');
  return MESES.findIndex(m => m.replace('[çc]', 'c') === n);
}

// ---------------------------------------------------------------------------
// Tira da frase o horário e a data, devolvendo o que achou e o texto que sobrou.
// Obs.: o \b do JavaScript não funciona depois de letra acentuada (amanhã, manhã), por
// isso essas palavras terminam com (?=[\s.,;:!?]|$) em vez de \b.
// ---------------------------------------------------------------------------
function extrair(texto, agora){
  let t = ' ' + texto + ' ';   // espaço nas pontas: os padrões abaixo começam com \s
  let horario = null;
  let data = null;
  let dataEhHoje = false;
  let m;

  // ---- horário ----
  const padroesHora = [
    // 11:00 · às 11:30 · para as 9:15
    { re: /\s(?:para\s+)?(?:[àa]s\s+)?(\d{1,2})\s*:\s*(\d{2})\b/i, h: 1, min: 2 },
    // 11h30 · às 11h30
    { re: /\s(?:para\s+)?(?:[àa]s\s+)?(\d{1,2})\s*h\s*(\d{2})\b/i, h: 1, min: 2 },
    // 11h · 11 horas · às 11 horas
    { re: /\s(?:para\s+)?(?:[àa]s\s+)?(\d{1,2})\s*(?:h|horas?)\b/i, h: 1, min: null },
    // às 11 (só com o "às", pra não confundir com outros números)
    { re: /\s(?:para\s+)?[àa]s\s+(\d{1,2})\b(?!\s*(?:\/|de\b))/i, h: 1, min: null }
  ];
  for(const p of padroesHora){
    m = t.match(p.re);
    if(!m) continue;
    const h = parseInt(m[p.h], 10);
    const min = p.min ? parseInt(m[p.min], 10) : 0;
    if(h > 23 || min > 59) continue;
    horario = { h, min };
    t = t.replace(m[0], ' ');
    break;
  }
  if(!horario){
    m = t.match(/\s(?:para\s+)?(?:[àa]s?\s+)?meio[\s-]?dia\b/i);
    if(m){ horario = { h: 12, min: 0 }; t = t.replace(m[0], ' '); }
  }
  if(!horario){
    m = t.match(/\s(?:para\s+)?(?:[àa]s?\s+)?meia[\s-]?noite\b/i);
    if(m){ horario = { h: 0, min: 0 }; t = t.replace(m[0], ' '); }
  }
  // "da manhã / da tarde / da noite": ajusta 8 da noite -> 20:00
  m = t.match(/\s(?:da|de|pela|na)\s+(manh[ãa]|tarde|noite|madrugada)(?=[\s.,;:!?]|$)/i);
  if(m && horario){
    const periodo = m[1].toLowerCase();
    if((periodo === 'tarde' || periodo === 'noite') && horario.h < 12) horario.h += 12;
    t = t.replace(m[0], ' ');
  }

  // ---- data ----
  const hoje = inicioDoDia(agora);

  if((m = t.match(/\s(?:para\s+)?depois\s+de\s+amanh[ãa](?=[\s.,;:!?]|$)/i))){
    data = somarDias(hoje, 2);
    t = t.replace(m[0], ' ');
  }else if((m = t.match(/\s(?:para\s+)?amanh[ãa](?=[\s.,;:!?]|$)/i))){
    data = somarDias(hoje, 1);
    t = t.replace(m[0], ' ');
  }else if((m = t.match(/\s(?:para\s+)?(?:hoje|agora)\b/i))){
    data = hoje;
    dataEhHoje = true;
    t = t.replace(m[0], ' ');
  }else if((m = t.match(new RegExp('\\s(?:para\\s+|na\\s+|no\\s+|pra\\s+|em\\s+|d[ao]\\s+)?(?:pr[óo]xim[ao]\\s+)?(' + DIAS_RE + ')(?:-feira)?(?:\\s+que\\s+vem)?\\b', 'i')))){
    const alvo = DIAS_SEMANA.find(d => new RegExp('^(?:' + d.re + ')$', 'i').test(m[1])).n;
    let falta = (alvo - hoje.getDay() + 7) % 7;
    if(falta === 0) falta = 7;               // "na segunda" dito numa segunda = a próxima
    data = somarDias(hoje, falta);
    t = t.replace(m[0], ' ');
  }else if((m = t.match(new RegExp('\\s(?:(?:para|no|em|do)\\s+)?dia\\s+(\\d{1,2})(?:\\s+de\\s+(' + MESES_RE + '))?\\b', 'i')))){
    const dia = parseInt(m[1], 10);
    if(dia >= 1 && dia <= 31){
      let mes = m[2] ? indiceDoMes(m[2]) : hoje.getMonth();
      let ano = hoje.getFullYear();
      let cand = new Date(ano, mes, dia);
      if(cand < hoje){
        if(m[2]) cand = new Date(ano + 1, mes, dia); else cand = new Date(ano, mes + 1, dia);
      }
      data = cand;
      t = t.replace(m[0], ' ');
    }
  }else if((m = t.match(/\s(?:(?:para|no|em)\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/))){
    const dia = parseInt(m[1], 10), mes = parseInt(m[2], 10) - 1;
    if(dia >= 1 && dia <= 31 && mes >= 0 && mes <= 11){
      let ano = m[3] ? parseInt(m[3], 10) : hoje.getFullYear();
      if(ano < 100) ano += 2000;
      let cand = new Date(ano, mes, dia);
      if(!m[3] && cand < hoje) cand = new Date(ano + 1, mes, dia);
      data = cand;
      t = t.replace(m[0], ' ');
    }
  }else if((m = t.match(new RegExp('\\s(?:(?:para|no|em)\\s+)?(\\d{1,2})\\s+de\\s+(' + MESES_RE + ')\\b', 'i')))){
    const dia = parseInt(m[1], 10), mes = indiceDoMes(m[2]);
    if(dia >= 1 && dia <= 31 && mes >= 0){
      let cand = new Date(hoje.getFullYear(), mes, dia);
      if(cand < hoje) cand = new Date(hoje.getFullYear() + 1, mes, dia);
      data = cand;
      t = t.replace(m[0], ' ');
    }
  }

  return {
    horario: horario ? pad2(horario.h) + ':' + pad2(horario.min) : null,
    data,
    dataEhHoje,
    semTempo: t
  };
}

// Limpeza final do título: espaços, pontuação, preposições soltas, 1ª letra maiúscula
function limparTitulo(s){
  let t = (s || '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
  t = t.replace(/^[,.;:\-–\s]+|[,.;:\-–\s]+$/g, '');
  // preposição sobrando no começo ou no fim depois de tirar data/horário
  let anterior;
  do{
    anterior = t;
    t = t.replace(/^(?:de|para|pra|que|a|o)\s+/i, '');
    t = t.replace(/\s+(?:em|no|na|para|pra|às|as|de|do|da|e|a)$/i, '');
  }while(t !== anterior);
  t = t.trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

// ---------------------------------------------------------------------------
// interpretarFrase("Acordar bebê às 11:00") ->
//   { tipo:'evento', tituloEvento, tituloTarefa, data:'2026-10-06', horario:'11:00', ... }
// ---------------------------------------------------------------------------
export function interpretarFrase(frase, agora = new Date()){
  const original = (frase || '').replace(/\s+/g, ' ').trim();
  if(!original) return null;

  const querTarefa = /\b(tarefa|task)\b/i.test(original);
  const querEvento = /\b(evento|compromisso|lembrete)\b/i.test(original);

  // 1) separa o "comando" do título.
  //    "crie uma task para agora coloque de nome Acordar bebê" -> título depois de "de nome"
  let textoTitulo;
  const marcador = original.match(/\b(?:com\s+o\s+nome|de\s+nome|com\s+o\s+t[ií]tulo|com\s+t[ií]tulo|chamad[ao]|intitulad[ao])\s*[:\-]?\s*/i);
  if(marcador){
    textoTitulo = original.slice(marcador.index + marcador[0].length);
  }else{
    textoTitulo = original.replace(
      /^(?:por favor[,\s]*)?(?:(?:cri(?:e|ar|a)|adicion(?:e|ar|a)|anot(?:e|ar|a)|marc(?:ar|que)|agend(?:e|ar|a)|coloc(?:ar|que)|registr(?:e|ar|a)|(?:me\s+)?lembr(?:e|ar|a))\s+)?(?:(?:uma?|o)\s+)?(?:nov[oa]\s+)?(?:tarefa|task|evento|compromisso|lembrete)?\s*(?:(?:para|de|pra)\s+)?/i,
      ''
    );
  }

  // 2) data e horário vêm da frase INTEIRA (o "amanhã" pode estar no comando)
  const tudo = extrair(original, agora);
  // 3) o título "limpo" (sem data/horário) vem só do trecho do título
  const soTitulo = extrair(textoTitulo, agora);

  const tituloEvento = limparTitulo(soTitulo.semTempo) || limparTitulo(textoTitulo) || limparTitulo(original);
  // versão para TAREFA: mantém horário e data no nome (tarefa não tem horário), só tira o "agora"
  const tituloTarefa = limparTitulo(textoTitulo.replace(/\s(?:para\s+)?agora\b/gi, ' ')) || tituloEvento;

  // 4) decide o tipo
  const temHorario = tudo.horario !== null;
  const temDataFutura = tudo.data !== null && !tudo.dataEhHoje;
  let tipo;
  if(querTarefa) tipo = 'tarefa';
  else if(querEvento || temHorario || temDataFutura) tipo = 'evento';
  else tipo = 'tarefa';

  // Se a pessoa disse "tarefa", ou se a frase virou EVENTO (e ela pode trocar pra tarefa no painel),
  // o título de tarefa mantém o horário/data — tarefa não tem horário próprio, então senão se perderia.
  // Se virou tarefa sozinha ("ligar pro João hoje"), usa o título limpo: "Ligar pro João".
  const tituloTarefaFinal = (querTarefa || tipo === 'evento') ? tituloTarefa : tituloEvento;

  return {
    tipo,
    tituloEvento,
    tituloTarefa: tituloTarefaFinal,
    data: paraISO(tudo.data || inicioDoDia(agora)),
    temData: tudo.data !== null,
    horario: tudo.horario
  };
}

// ---------------------------------------------------------------------------
// Painel de criar por voz
// ---------------------------------------------------------------------------
const MENSAGENS_ERRO = {
  'not-allowed': 'O microfone está bloqueado. Libere nas configurações do site (cadeado na barra de endereço) e tente de novo.',
  'service-not-allowed': 'O microfone está bloqueado. Libere nas configurações do site e tente de novo.',
  'no-speech': 'Não ouvi nada. Toque no microfone e fale de novo.',
  'audio-capture': 'Não encontrei um microfone neste aparelho.',
  'network': 'Sem internet: o reconhecimento de voz precisa de conexão.',
  'aborted': ''
};

function el(tag, classe, texto){
  const e = document.createElement(tag);
  if(classe) e.className = classe;
  if(texto !== undefined) e.textContent = texto;
  return e;
}

// api = { criarTarefa(titulo, freq), criarEvento(dados), avisar(msg) }
export function abrirPainelDeVoz(api, opcoes = {}){
  if(document.getElementById('vozOverlay')) return;   // já aberto

  const Reconhecimento = window.SpeechRecognition || window.webkitSpeechRecognition;
  let reconhecimento = null;
  let ouvindo = false;
  let interpretado = null;
  let tipoAtual = 'tarefa';
  let tituloEditadoPelaPessoa = false;

  // ---------- montagem da tela ----------
  const overlay = el('div', 'voz-overlay');
  overlay.id = 'vozOverlay';
  const folha = el('div', 'voz-folha');
  overlay.appendChild(folha);

  const topo = el('div', 'voz-topo');
  topo.appendChild(el('strong', '', 'Criar por voz'));
  const fechar = el('button', 'voz-fechar', '✕');
  fechar.type = 'button';
  fechar.setAttribute('aria-label', 'Fechar');
  topo.appendChild(fechar);
  folha.appendChild(topo);

  const status = el('div', 'voz-status', '');
  folha.appendChild(status);

  const linhaFala = el('div', 'voz-fala');
  const caixa = el('textarea', 'voz-texto');
  caixa.rows = 2;
  caixa.placeholder = Reconhecimento
    ? 'Toque no microfone e fale, ou digite aqui. Ex.: Acordar bebê às 11:00'
    : 'Digite aqui. Ex.: Acordar bebê às 11:00';
  linhaFala.appendChild(caixa);
  const mic = el('button', 'voz-mic', '🎤');
  mic.type = 'button';
  mic.setAttribute('aria-label', 'Falar');
  if(!Reconhecimento) mic.style.display = 'none';
  linhaFala.appendChild(mic);
  folha.appendChild(linhaFala);

  // "o que entendi"
  const entendi = el('div', 'voz-entendi');
  entendi.style.display = 'none';

  const linhaTipo = el('div', 'voz-tipo');
  const btnTarefa = el('button', 'voz-tipo-btn', 'Tarefa');
  const btnEvento = el('button', 'voz-tipo-btn', 'Evento no calendário');
  btnTarefa.type = btnEvento.type = 'button';
  linhaTipo.appendChild(btnTarefa);
  linhaTipo.appendChild(btnEvento);
  entendi.appendChild(linhaTipo);

  const titulo = el('input', 'voz-titulo');
  titulo.type = 'text';
  titulo.maxLength = 120;
  titulo.placeholder = 'Título';
  entendi.appendChild(titulo);

  const camposTarefa = el('div', 'voz-campos');
  camposTarefa.appendChild(document.createTextNode('Repete:'));
  const selFreq = el('select');
  [['once', 'Só uma vez (única)'], ['daily', 'Todo dia'], ['weekly', 'Toda semana'], ['monthly', 'Todo mês']]
    .forEach(([v, rotulo]) => {
      const o = el('option', '', rotulo);
      o.value = v;
      selFreq.appendChild(o);
    });
  camposTarefa.appendChild(selFreq);
  entendi.appendChild(camposTarefa);

  const camposEvento = el('div', 'voz-campos');
  const inData = el('input');
  inData.type = 'date';
  const inHora = el('input');
  inHora.type = 'time';
  const rotuloDia = el('label', 'voz-diatodo');
  const chkDiaTodo = el('input');
  chkDiaTodo.type = 'checkbox';
  rotuloDia.appendChild(chkDiaTodo);
  rotuloDia.appendChild(document.createTextNode(' dia todo'));
  camposEvento.appendChild(inData);
  camposEvento.appendChild(inHora);
  camposEvento.appendChild(rotuloDia);
  entendi.appendChild(camposEvento);
  folha.appendChild(entendi);

  const acoes = el('div', 'voz-acoes');
  const btnCriar = el('button', 'voz-criar', 'Criar');
  btnCriar.type = 'button';
  btnCriar.disabled = true;
  const btnCancelar = el('button', 'voz-cancelar', 'Cancelar');
  btnCancelar.type = 'button';
  acoes.appendChild(btnCriar);
  acoes.appendChild(btnCancelar);
  folha.appendChild(acoes);

  document.body.appendChild(overlay);

  // ---------- comportamento ----------
  function mostrarStatus(msg, erro){
    status.textContent = msg || '';
    status.classList.toggle('erro', !!erro);
  }

  function atualizarTipo(tipo, trocarTitulo){
    tipoAtual = tipo;
    btnTarefa.classList.toggle('ativo', tipo === 'tarefa');
    btnEvento.classList.toggle('ativo', tipo === 'evento');
    camposTarefa.style.display = tipo === 'tarefa' ? '' : 'none';
    camposEvento.style.display = tipo === 'evento' ? '' : 'none';
    // se a pessoa ainda não mexeu no título, troca pela versão certa do tipo
    if(trocarTitulo && interpretado && !tituloEditadoPelaPessoa){
      titulo.value = tipo === 'evento' ? interpretado.tituloEvento : interpretado.tituloTarefa;
    }
  }

  function entender(){
    const frase = caixa.value.trim();
    interpretado = interpretarFrase(frase);
    if(!interpretado){
      entendi.style.display = 'none';
      btnCriar.disabled = true;
      return;
    }
    tituloEditadoPelaPessoa = false;
    entendi.style.display = '';
    inData.value = interpretado.data;
    inHora.value = interpretado.horario || '';
    chkDiaTodo.checked = !interpretado.horario;
    inHora.disabled = chkDiaTodo.checked;
    selFreq.value = 'once';
    atualizarTipo(interpretado.tipo, true);
    btnCriar.disabled = false;
  }

  let temporizador = null;
  caixa.addEventListener('input', () => {
    clearTimeout(temporizador);
    temporizador = setTimeout(entender, 400);
  });
  titulo.addEventListener('input', () => { tituloEditadoPelaPessoa = true; });
  btnTarefa.onclick = () => atualizarTipo('tarefa', true);
  btnEvento.onclick = () => atualizarTipo('evento', true);
  chkDiaTodo.onchange = () => {
    inHora.disabled = chkDiaTodo.checked;
    if(!chkDiaTodo.checked && !inHora.value) inHora.value = '09:00';
  };

  function pararDeOuvir(){
    if(reconhecimento && ouvindo){
      try{ reconhecimento.stop(); }catch(e){}
    }
  }

  function comecarAOuvir(){
    if(!Reconhecimento) return;
    if(ouvindo){ pararDeOuvir(); return; }
    reconhecimento = new Reconhecimento();
    reconhecimento.lang = 'pt-BR';
    reconhecimento.interimResults = true;
    reconhecimento.continuous = false;
    reconhecimento.maxAlternatives = 1;

    reconhecimento.onstart = () => {
      ouvindo = true;
      mic.classList.add('ouvindo');
      mostrarStatus('Ouvindo... fale agora.');
    };
    reconhecimento.onresult = (ev) => {
      let texto = '';
      for(let i = 0; i < ev.results.length; i++) texto += ev.results[i][0].transcript;
      caixa.value = texto;
      if(ev.results[ev.results.length - 1].isFinal){
        clearTimeout(temporizador);
        entender();
      }
    };
    reconhecimento.onerror = (ev) => {
      const msg = MENSAGENS_ERRO[ev.error];
      mostrarStatus(msg === undefined ? 'Não consegui ouvir (' + ev.error + ').' : msg, !!msg);
    };
    reconhecimento.onend = () => {
      ouvindo = false;
      mic.classList.remove('ouvindo');
      if(status.textContent.startsWith('Ouvindo')){
        mostrarStatus(caixa.value ? 'Confira abaixo e toque em Criar.' : 'Não ouvi nada. Toque no microfone e fale de novo.');
      }
    };
    try{
      reconhecimento.start();
    }catch(e){
      mostrarStatus('Toque no microfone para falar.');
    }
  }

  function fecharPainel(){
    pararDeOuvir();
    clearTimeout(temporizador);
    overlay.remove();
  }

  mic.onclick = comecarAOuvir;
  fechar.onclick = fecharPainel;
  btnCancelar.onclick = fecharPainel;

  btnCriar.onclick = () => {
    const texto = titulo.value.trim();
    if(!texto){ mostrarStatus('Escreva um título.', true); return; }
    if(tipoAtual === 'tarefa'){
      api.criarTarefa(texto, selFreq.value);
      api.avisar('Tarefa criada: ' + texto);
    }else{
      if(!inData.value){ mostrarStatus('Escolha a data do evento.', true); return; }
      api.criarEvento({
        titulo: texto,
        dataInicio: inData.value,
        dataFim: inData.value,
        horario: chkDiaTodo.checked ? null : (inHora.value || null),
        recorrencia: 'nenhuma',
        cor: '#1D6FA5',
        notas: ''
      });
      const quando = inData.value.split('-').reverse().join('/') + (chkDiaTodo.checked || !inHora.value ? '' : ' às ' + inHora.value);
      api.avisar('Evento criado: ' + texto + ' (' + quando + ')');
    }
    fecharPainel();
  };

  if(!Reconhecimento){
    mostrarStatus('Este navegador não tem reconhecimento de voz. Digite a frase.');
    caixa.focus();
  }else if(opcoes.autoIniciar){
    mostrarStatus('Toque no microfone para falar.');
    comecarAOuvir();     // se o navegador exigir um toque, o aviso acima continua valendo
  }else{
    mostrarStatus('Toque no microfone e fale.');
  }
}
