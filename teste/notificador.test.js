const test = require('node:test');
const assert = require('node:assert');
const { calcularAvisos } = require('../notificador');

// 19/11/2026 é uma quinta-feira (dia 4)
const d = (s) => new Date(s); // horário local do servidor de teste

test('bloco: avisa 1 h antes, uma vez na janela, com o texto no formato combinado', () => {
  const bloco = { id: 'b1', dia: 4, inicio: '08:00', texto: 'Ir na faculdade', avisoAntes: 60 };
  assert.strictEqual(calcularAvisos(d('2026-11-19T06:59:00'), [bloco], []).length, 0);
  const r = calcularAvisos(d('2026-11-19T07:02:00'), [bloco], []);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].corpo, '08:00 (daqui a 1 h): Ir na faculdade');
  assert.strictEqual(calcularAvisos(d('2026-11-19T07:20:00'), [bloco], []).length, 0); // perdeu a janela
});

test('bloco: dia da semana errado, sem aviso (-1) e padrão de 10 min', () => {
  assert.strictEqual(calcularAvisos(d('2026-11-19T07:02:00'), [{ id: 'x', dia: 3, inicio: '08:00', texto: 't', avisoAntes: 60 }], []).length, 0);
  assert.strictEqual(calcularAvisos(d('2026-11-19T07:02:00'), [{ id: 'x', dia: 4, inicio: '08:00', texto: 't', avisoAntes: -1 }], []).length, 0);
  const padrao = calcularAvisos(d('2026-11-19T07:51:00'), [{ id: 'x', dia: 4, inicio: '08:00', texto: 'Café' }], []);
  assert.strictEqual(padrao[0].corpo, '08:00 (daqui a 10 min): Café');
  const agora = calcularAvisos(d('2026-11-19T08:00:30'), [{ id: 'x', dia: 4, inicio: '08:00', texto: 'Café', avisoAntes: 0 }], []);
  assert.strictEqual(agora[0].corpo, '08:00 (agora): Café');
});

test('bloco logo depois da meia-noite avisa na noite anterior', () => {
  // sexta (dia 5) 00:05, aviso 10 min => 23:55 de quinta
  const r = calcularAvisos(d('2026-11-19T23:56:00'), [{ id: 'b', dia: 5, inicio: '00:05', texto: 'Dormir', avisoAntes: 10 }], []);
  assert.strictEqual(r.length, 1);
});

test('a chave muda se o horário muda (permite avisar de novo) e é estável se não muda', () => {
  const b = { id: 'b1', dia: 4, inicio: '08:00', texto: 't', avisoAntes: 10 };
  const k1 = calcularAvisos(d('2026-11-19T07:51:00'), [b], [])[0].chave;
  const k2 = calcularAvisos(d('2026-11-19T07:55:00'), [b], [])[0].chave;
  assert.strictEqual(k1, k2);
  const k3 = calcularAvisos(d('2026-11-19T07:51:00'), [{ ...b, avisoAntes: 10, inicio: '08:00', texto: 'outro' }], [])[0].chave;
  assert.strictEqual(k1, k3); // mexer só no texto não repete
  const k4 = calcularAvisos(d('2026-11-19T08:01:00'), [{ ...b, inicio: '08:10' }], [])[0].chave;
  assert.notStrictEqual(k1, k4);
});

test('evento: 1 dia antes às 09:00', () => {
  const ev = { id: 'e1', titulo: 'Festa', dataInicio: '2026-11-20', dataFim: '2026-11-20', horario: '20:00', avisoDias: 1, avisoHora: '09:00', avisoAte: '2026-11-20' };
  assert.strictEqual(calcularAvisos(d('2026-11-19T08:59:00'), [], [ev]).length, 0);
  const r = calcularAvisos(d('2026-11-19T09:03:00'), [], [ev]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].titulo, 'Festa');
  assert.strictEqual(r[0].corpo, 'amanhã, 20/11 às 20:00');
  assert.strictEqual(calcularAvisos(d('2026-11-19T10:30:00'), [], [ev]).length, 0);
});

test('evento: X min antes do horário e só com horário', () => {
  const ev = { id: 'e2', titulo: 'Dentista', dataInicio: '2026-11-19', horario: '15:00', avisoMinutos: 30 };
  assert.strictEqual(calcularAvisos(d('2026-11-19T14:31:00'), [], [ev])[0].corpo, '15:00 (daqui a 30 min)');
  const semHorario = { id: 'e3', titulo: 'X', dataInicio: '2026-11-19', horario: null, avisoMinutos: 30 };
  assert.strictEqual(calcularAvisos(d('2026-11-19T14:31:00'), [], [semHorario]).length, 0);
});

test('evento sem aviso (antigo) não avisa', () => {
  assert.strictEqual(calcularAvisos(d('2026-11-19T09:00:00'), [], [{ id: 'e', titulo: 'a', dataInicio: '2026-11-20' }]).length, 0);
});

test('evento anual (aniversário) avisa 3 dias antes; mensal em mês curto', () => {
  const aniv = { id: 'a', titulo: 'Aniversário', dataInicio: '2001-11-22', recorrencia: 'anual', avisoDias: 3, avisoHora: '09:00', avisoAte: '9999-12-31' };
  const r = calcularAvisos(d('2026-11-19T09:05:00'), [], [aniv]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].corpo, 'daqui a 3 dias, 22/11');
  const mensal = { id: 'm', titulo: 'Conta', dataInicio: '2026-01-31', recorrencia: 'mensal', avisoDias: 0, avisoHora: '08:00', avisoAte: '9999-12-31' };
  // fevereiro de 2027 só tem 28 dias: avisa no dia 28
  assert.strictEqual(calcularAvisos(d('2027-02-28T08:05:00'), [], [mensal]).length, 1);
  assert.strictEqual(calcularAvisos(d('2027-02-27T08:05:00'), [], [mensal]).length, 0);
});
