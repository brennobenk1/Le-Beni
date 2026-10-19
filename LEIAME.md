# Le&Beni — como colocar no ar

Três arquivos fazem o site funcionar:

- `le-beni.html` — a página. Vai pra hospedagem.
- `servidor/worker.js` + `servidor/schema.sql` + `servidor/wrangler.toml` — o servidor, na Cloudflare.

O servidor existe por um motivo só: ele guarda o acesso ao Drive **longe da página**.
Ninguém que abrir o site enxerga esse acesso. É ele também que confere, a cada gravação,
se quem está pedindo é um dos dois e-mails autorizados.

Quem pode gravar já está configurado:

```
leticiadearaujofernandes@gmail.com
sauriandrawn@gmail.com
```

Todo o resto do mundo abre o link e vê tudo, sem login.

---

## Parte 1 — a conta do Drive

Crie (ou entre n)a conta Google que vai ser **só do site**. É a dona das fotos.
Faça tudo abaixo logado **nessa** conta.

1. Abra <https://console.cloud.google.com/> e crie um projeto. Nome: `le-beni`.
2. Menu **APIs e serviços → Biblioteca**. Procure **Google Drive API** e clique em **Ativar**.
3. Menu **APIs e serviços → Tela de permissão OAuth**:
   - Tipo: **Externo**.
   - Nome do app: `Le&Beni`. E-mail de suporte e de contato: a conta do site.
   - Em **Escopos**, adicione só este: `.../auth/drive.file`.
   - Salve e, no fim, clique em **PUBLICAR APP** (status *Em produção*).
     **Esse passo é obrigatório.** Deixando em *Teste*, o acesso expira a cada 7 dias
     e o site para de gravar. Com o escopo `drive.file` a publicação é automática,
     o Google não pede verificação nenhuma.
4. Menu **APIs e serviços → Credenciais → Criar credenciais → ID do cliente OAuth**:
   - Tipo: **Aplicativo da Web**. Nome: `le-beni`.
   - Em **URIs de redirecionamento autorizados**, adicione:
     `https://developers.google.com/oauthplayground`
   - Em **Origens JavaScript autorizadas**, adicione o endereço onde o site vai ficar,
     por exemplo `https://seunome.github.io`. (Pode voltar aqui depois e acrescentar.)
   - Clique em criar e **guarde o Client ID e o Client Secret**.

### Pegar o acesso permanente ao Drive

5. Abra <https://developers.google.com/oauthplayground>, ainda logado na conta do site.
6. Clique na engrenagem (canto superior direito) e marque **Use your own OAuth credentials**.
   Cole ali o Client ID e o Client Secret do passo 4.
7. Na lista da esquerda, role até **Drive API v3** e marque **`https://www.googleapis.com/auth/drive.file`**.
8. **Authorize APIs** → entre com a conta do site → **Exchange authorization code for tokens**.
9. Copie o **Refresh token**. Guarde. É ele que deixa o servidor gravar pra sempre sem pedir login de novo.

---

## Parte 2 — o servidor na Cloudflare

Precisa do Node instalado. Abra o terminal na pasta `servidor`.

```bash
npx wrangler login
npx wrangler d1 create le-beni
```

O segundo comando imprime um `database_id`. Abra `wrangler.toml` e cole no lugar de `COLE-AQUI`.

Crie as tabelas:

```bash
npx wrangler d1 execute le-beni --remote --file=schema.sql
```

Guarde os quatro segredos (ele pergunta o valor de cada um):

```bash
npx wrangler secret put GOOGLE_CLIENT_ID      # o Client ID do passo 4
npx wrangler secret put DRIVE_CLIENT_ID       # o mesmo Client ID
npx wrangler secret put DRIVE_CLIENT_SECRET   # o Client Secret do passo 4
npx wrangler secret put DRIVE_REFRESH_TOKEN   # o Refresh token do passo 9
```

Publique:

```bash
npx wrangler deploy
```

No fim ele mostra o endereço, algo como `https://le-beni.seunome.workers.dev`. **Guarde.**

> O Worker cria sozinho uma pasta chamada **Le&Beni — fotos** no Drive da conta do site,
> e é lá que as fotos ficam. Aquela pasta que você criou à mão não serve: a permissão
> `drive.file`, que é a segura, só alcança o que o próprio site cria. Se você fizer questão
> daquela pasta, dá pra forçar com `npx wrangler secret put DRIVE_FOLDER_ID`, mas aí o app
> precisaria de uma permissão ampla do Google, que exige auditoria paga. Não vale a pena.

---

## Parte 3 — a página

Abra `le-beni.html` num editor de texto. Logo no começo do script tem isto:

```js
var CONFIG = {
  API: "",
  GOOGLE_CLIENT_ID: ""
};
```

Preencha:

```js
var CONFIG = {
  API: "https://le-beni.seunome.workers.dev",
  GOOGLE_CLIENT_ID: "123456-abc.apps.googleusercontent.com"
};
```

Nenhum dos dois é segredo — podem ficar à vista.

Agora é só hospedar. O caminho mais curto é o GitHub Pages:

1. Crie um repositório no GitHub, público.
2. Suba o `le-beni.html` e renomeie pra `index.html`.
3. **Settings → Pages**, em *Source* escolha a branch `main` e salve.
4. Em um ou dois minutos o site está em `https://seunome.github.io/nome-do-repo/`.

Volte no passo 4 da Parte 1 e confirme que esse endereço está nas **Origens JavaScript
autorizadas**, senão o botão de login não aparece.

---

## Conferindo

- Abra o site numa janela anônima: deve carregar o mapa e **não** mostrar os botões de adicionar.
- Abra normalmente e clique no bonequinho, no alto à direita: entre com um dos dois e-mails.
  Os botões aparecem.
- Marque um lugar com uma foto. Recarregue. A foto continua lá.
- Abra pelo celular, sem logar: a foto aparece.
- Entre no Drive da conta do site: a pasta **Le&Beni — fotos** está lá com os arquivos.

## Se algo não funcionar

- **O botão de login não aparece.** O endereço do site não está nas Origens JavaScript
  autorizadas, ou o `GOOGLE_CLIENT_ID` está errado.
- **"Esta conta não pode gravar aqui."** O e-mail que entrou não está em `ALLOWED_EMAILS`.
  Corrija o `wrangler.toml` e rode `npx wrangler deploy` de novo.
- **Parou de gravar depois de uma semana.** A tela de permissão OAuth ficou em *Teste*.
  Volte e publique o app.
- **O GPS não liga.** O site precisa estar em `https://`. Arquivo aberto do computador não serve.

## O tamanho disso tudo

As fotos são encolhidas antes de subir: cada uma fica em torno de 400 KB, mais uma
miniatura de 25 KB. Nos 15 GB da conta nova, isso dá por volta de **30 mil fotos**.
O banco de dados guarda só texto e é gratuito e sem limite prático pra esse uso.
