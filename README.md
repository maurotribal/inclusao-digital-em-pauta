# Inclusão Digital em Pauta

Boletim diário automático de notícias sobre inclusão digital no Brasil.
Custo zero: **GitHub Pages** (hospedagem) + **GitHub Actions** (robô diário) + **feeds RSS públicos** (conteúdo).

## Como funciona

Todo dia às 09:00 (Brasília) o workflow `boletim-diario.yml` executa `scripts/gerar-boletim.js`, que:

1. Busca notícias no Google News RSS com 6 consultas temáticas;
2. Filtra: últimas 48 horas, palavras-chave de inclusão digital, sem repetir matérias já publicadas (`data/publicados.json`);
3. Classifica em categorias (Políticas Públicas, Educação Digital, Acesso e Conectividade, Panorama);
4. Gera a página do boletim em `posts/AAAA-MM-DD.html` e regenera o `index.html`;
5. Faz commit e push — o GitHub Pages republica sozinho.

Se houver menos de 2 matérias novas, a edição do dia não é publicada (evita boletim vazio).

## Instalação (uma única vez)

1. **Criar o repositório** (público) no GitHub, por exemplo `inclusao-digital-em-pauta`, e enviar todos os arquivos deste pacote preservando a estrutura de pastas (inclusive a pasta oculta `.github`).

2. **Permitir que o robô escreva no repositório:**
   Settings → Actions → General → Workflow permissions → marcar **Read and write permissions** → Save.

3. **Ativar o GitHub Pages:**
   Settings → Pages → Source: **Deploy from a branch** → Branch: `main`, pasta `/ (root)` → Save.

4. **Testar agora, sem esperar o horário:**
   Aba Actions → workflow "Boletim Diário de Inclusão Digital" → **Run workflow**.
   Em 1–2 minutos o commit aparece e o site é publicado em
   `https://SEU-USUARIO.github.io/NOME-DO-REPO/`.

## Estrutura

```
├── index.html                      ← capa (regenerada pelo robô)
├── assets/estilo.css               ← identidade visual
├── posts/                          ← uma página por edição
├── data/
│   ├── publicados.json             ← histórico anti-repetição (600 URLs)
│   └── boletins.json               ← índice das edições
├── scripts/gerar-boletim.js        ← o robô (Node 20, zero dependências)
└── .github/workflows/boletim-diario.yml  ← agendamento diário
```

## Ajustes comuns

- **Horário:** editar o `cron` no workflow (`0 12 * * *` = 12:00 UTC = 09:00 BRT).
- **Consultas e palavras-chave:** arrays `CONSULTAS` e `PALAVRAS_CHAVE` no início do script.
- **Quantidade de matérias:** constantes `MAX_ITENS` e `MIN_ITENS`.

## Observação sobre o cron do GitHub

O agendamento do Actions pode atrasar alguns minutos (fila compartilhada). Para o caso de uso — boletim diário — isso é irrelevante. Repositórios sem commits por 60 dias têm workflows agendados pausados automaticamente pelo GitHub; como este projeto gera um commit por dia, isso nunca acontece na prática.
