// Cole este código no CONSOLE do navegador (F12 > Console) do seu PC, com o Rotina ANTIGO
// aberto (https://vinex775.github.io/rotina/) e logado. Ele só LÊ seus dados e baixa um
// arquivo "rotina-export.json". Nada é alterado no Firebase.
// (O Chrome pode pedir para digitar "allow pasting" antes de aceitar colar no console.)
(async () => {
  const base = 'https://vinex775.github.io/rotina/';
  const { db, auth } = await import(base + 'firebase-init.js');
  const F = await import('https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js');
  const uid = auth.currentUser.uid;
  const colecoes = ['tarefas', 'blocos', 'eventos', 'projetos'];

  const saida = { usuario: null };
  const refUser = F.doc(db, 'usuarios', uid);
  let u = null;
  try { u = await F.getDoc(refUser); } catch (e) { u = await F.getDocFromCache(refUser); }
  saida.usuario = u && u.exists() ? u.data() : null;
  for (const col of colecoes) {
    const ref = F.collection(db, 'usuarios', uid, col);
    let snap;
    try { snap = await F.getDocs(ref); }
    catch (e) { console.warn(col + ': servidor falhou, usando cópia do aparelho', e.code || e); snap = await F.getDocsFromCache(ref); }
    saida[col] = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
  }
  const blob = new Blob([JSON.stringify(saida)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'rotina-export.json';
  a.click();
  console.log('Exportado:', Object.fromEntries(colecoes.map((c) => [c, saida[c].length])));
})();
