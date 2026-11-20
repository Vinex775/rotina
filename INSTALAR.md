# Rotina no servidor "tio" — passo a passo

Cada comando vem com a explicação do que ele faz. Nada aqui apaga ou altera o Pi-hole,
o Syncthing ou qualquer coisa que já esteja no tio: o Rotina vive numa pasta só dele.

## O que é cada coisa
- `server.js`: o programa (Node.js). Guarda os dados num arquivo SQLite, faz o login,
  avisa os aparelhos em tempo real e manda as notificações.
- `public/`: o site (o mesmo Rotina, agora falando com o servidor em vez do Firebase).
- `dados/`: criada sozinha na primeira execução. Tem o banco (`rotina.db`) e as cópias
  de segurança diárias (`dados/copias/`).

## 1. Levar a pasta para o tio
Copie a pasta `rotina-servidor` para o tio, por exemplo para `~/rotina` (pelo Syncthing,
`scp` ou pendrive). Os comandos abaixo supõem `~/rotina`.

## 2. Instalar o Node.js
```
sudo apt update && sudo apt install -y nodejs npm
node -v
```
- O primeiro comando atualiza a lista de programas e instala o Node.js (o "motor" que roda
  o servidor) e o npm (o instalador das peças que o servidor usa).
- `node -v` só mostra a versão. Precisa ser 18 ou maior (o Ubuntu 24.04 traz a 18).

## 3. Instalar as peças do servidor
```
cd ~/rotina
npm ci --omit=dev
```
- Entra na pasta e baixa as 3 bibliotecas que o servidor usa (Express para o site, SQLite
  para o banco, web-push para as notificações), nas versões exatas do arquivo
  `package-lock.json`. Só mexe dentro de `~/rotina/node_modules`.
- Se der erro de "compilar" (`gyp`), instale as ferramentas de compilação com
  `sudo apt install -y build-essential python3` e rode de novo.

## 4. Testar na mão
```
node server.js
```
Deve aparecer `Rotina rodando em http://127.0.0.1:3000`. Em outro terminal,
`curl http://127.0.0.1:3000/api/saude` deve responder `{"ok":true}`.
Volte ao primeiro terminal e pare com `Ctrl+C`.
(`127.0.0.1` significa "só este computador": o Rotina não fica aberto para a rede de casa.)

## 5. Deixar ligado para sempre (systemd)
```
sed "s|USUARIO|$USER|; s|CAMINHO|$HOME/rotina|" rotina.service | sudo tee /etc/systemd/system/rotina.service
sudo systemctl daemon-reload
sudo systemctl enable --now rotina
systemctl status rotina
```
- O `sed` troca os dois espaços reservados pelo seu usuário e pela pasta, e o `tee` grava o
  resultado como serviço do sistema (você pode abrir o arquivo com `cat` para conferir).
- `daemon-reload` faz o systemd reler os serviços; `enable --now` liga agora e em todo boot.
- `status` deve mostrar `active (running)`. Para ver o que o servidor imprime:
  `journalctl -u rotina -f` (sai com Ctrl+C).

## 6. Acesso por HTTPS com o Tailscale
Notificações do navegador exigem HTTPS. O Tailscale cria isso de graça:
1. No painel do Tailscale (login.tailscale.com > DNS), ative **MagicDNS** e **HTTPS Certificates**.
2. No tio:
```
sudo tailscale serve --bg 3000
tailscale serve status
```
- O primeiro comando publica, **só dentro da sua rede Tailscale**, o servidor local na porta
  3000 com HTTPS (o Tailscale cuida do certificado). O segundo mostra o endereço, algo como
  `https://tio.nome-da-sua-rede.ts.net`.
- Para desfazer: `sudo tailscale serve reset`.
No celular e no PC, o app do Tailscale precisa estar ligado para abrir esse endereço.

## 7. Primeiro acesso e trazer seus dados
1. Abra o endereço do passo 6 e toque em **Criar conta** (a primeira conta é a sua; depois
   disso o servidor recusa novas contas). O login fica lembrado por ~13 meses.
2. No PC, abra o Rotina ANTIGO (https://vinex775.github.io/rotina/), logado, aperte F12, aba
   Console, e cole o conteúdo de `exportar-firestore.js`. Ele só lê seus dados e baixa
   `rotina-export.json`. (Se o Chrome pedir, digite `allow pasting` antes de colar. Se a cota
   do Firebase do dia estiver estourada, ele usa a cópia que o navegador já guarda.)
3. Abra `https://SEU-ENDEREÇO/importar.html`, escolha o arquivo e clique em Importar.
   É seguro repetir: não duplica nada.

## 8. Notificações
Em cada aparelho, abra o Rotina no endereço novo, toque em **🔔 Notificações** e permita.
Chega uma notificação de teste na hora. No celular, "Adicionar à tela inicial" para instalar
como app (o app antigo do GitHub Pages é outro endereço, então este é um app novo).
Quando tudo estiver funcionando, **desligue o Worker do Cloudflare e o workflow do GitHub
Actions** para não haver avisos duplicados.

## 9. Cópia de segurança (importante: o HD do tio já deu sinais de problema)
O servidor faz uma cópia diária do banco às ~03:00 em `~/rotina/dados/copias/` (guarda as
últimas 14). Aponte o **Syncthing** para essa pasta, enviando para o seu PC, para ter a cópia
fora do tio.

## Atualizar o Rotina depois
Troque os arquivos da pasta `public/` (o site) quando quiser: basta recarregar a página.
Mudou `server.js`? `sudo systemctl restart rotina`.

## O que mudou em relação ao Firebase (para você saber)
- Sem internet em casa ou com o tio desligado, o Rotina não sincroniza. Alterações feitas
  nesse meio-tempo ficam guardadas no aparelho e sobem sozinhas quando a conexão volta.
- Os avisos de notificação não passam mais pelo Cloudflare/GitHub: o próprio servidor confere
  a cada 30 s e avisa até 15 min depois da hora (ou até 1 h para avisos de "N dias antes").
- O arquivo `notificador.js` tem as regras dos avisos; `npm test` roda os testes.
