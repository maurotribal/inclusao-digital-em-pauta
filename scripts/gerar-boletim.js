/**
 * gerar-boletim.js — Boletim diário de Inclusão Digital
 * Zero dependências. Node 20+ (fetch nativo).
 *
 * Fluxo:
 *  1. Busca Google News RSS (várias consultas temáticas)
 *  2. Filtra: últimas 48h + palavras-chave + dedup (data/publicados.json)
 *  3. Classifica em categorias e ranqueia por relevância
 *  4. Gera posts/AAAA-MM-DD.html + regenera index.html
 *  5. Atualiza data/publicados.json e data/boletins.json
 *
 * Se não houver matérias novas suficientes, sai sem publicar (exit 0).
 */

const fs = require("fs");
const path = require("path");

const RAIZ = path.join(__dirname, "..");
const DIR_POSTS = path.join(RAIZ, "posts");
const ARQ_PUBLICADOS = path.join(RAIZ, "data", "publicados.json");
const ARQ_BOLETINS = path.join(RAIZ, "data", "boletins.json");

const CONSULTAS = [
  "inclusão digital",
  "alfabetização digital",
  "letramento digital",
  "exclusão digital",
  "telecentro",
  "conectividade internet política pública"
];

// Palavras-chave: pelo menos uma precisa aparecer no título ou resumo
const PALAVRAS_CHAVE = [
  "inclusão digital", "inclusao digital",
  "alfabetização digital", "alfabetizacao digital",
  "letramento digital", "exclusão digital", "exclusao digital",
  "telecentro", "cidadania digital", "educação digital", "educacao digital",
  "acesso à internet", "acesso a internet", "banda larga",
  "conectividade", "capacitação digital", "capacitacao digital",
  "pned", "governo digital", "divisão digital", "brecha digital"
];

const CATEGORIAS = [
  { nome: "Políticas Públicas", cor: "amarelo",
    termos: ["pned", "lei", "governo", "prefeitura", "ministério", "ministerio",
             "política", "politica", "programa", "decreto", "investimento", "verba"] },
  { nome: "Educação Digital", cor: "ciano",
    termos: ["curso", "capacitação", "capacitacao", "alfabetização", "alfabetizacao",
             "letramento", "escola", "aluno", "formação", "formacao", "oficina", "aula"] },
  { nome: "Acesso e Conectividade", cor: "verde",
    termos: ["internet", "banda larga", "conectividade", "wi-fi", "wifi", "5g",
             "fibra", "sinal", "rede", "antena", "starlink"] }
];

const MAX_ITENS = 10;
const MIN_ITENS = 2;
const JANELA_HORAS = 48;
const LIMITE_HISTORICO = 600;

// ---------- utilidades ----------

function lerJson(arquivo, padrao) {
  try { return JSON.parse(fs.readFileSync(arquivo, "utf8")); }
  catch { return padrao; }
}

function salvarJson(arquivo, dados) {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  fs.writeFileSync(arquivo, JSON.stringify(dados, null, 2), "utf8");
}

function decodificarEntidades(s) {
  return (s || "")
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, " ");
}

function limparHtml(s) {
  return decodificarEntidades(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function escaparHtml(s) {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function normalizarUrl(u) {
  try {
    const url = new URL(u);
    return (url.origin + url.pathname).toLowerCase().replace(/\/$/, "");
  } catch { return (u || "").toLowerCase(); }
}

function extrairTag(bloco, tag) {
  const m = bloco.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? m[1].trim() : "";
}

// ---------- coleta ----------

async function buscarRss(consulta) {
  const url = "https://news.google.com/rss/search?q=" +
    encodeURIComponent(consulta) + "&hl=pt-BR&gl=BR&ceid=BR:pt-419";
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (BoletimInclusaoDigital/1.0)" }
    });
    if (!resp.ok) { console.warn(`RSS ${consulta}: HTTP ${resp.status}`); return []; }
    const xml = await resp.text();
    const itens = [];
    const blocos = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    for (const bloco of blocos) {
      const titulo = limparHtml(extrairTag(bloco, "title"));
      const link = decodificarEntidades(extrairTag(bloco, "link"));
      const dataPub = new Date(extrairTag(bloco, "pubDate"));
      const fonte = limparHtml(extrairTag(bloco, "source"));
      const resumo = limparHtml(extrairTag(bloco, "description"));
      if (titulo && link && !isNaN(dataPub)) {
        itens.push({ titulo, link, dataPub, fonte, resumo });
      }
    }
    return itens;
  } catch (e) {
    console.warn(`RSS ${consulta}: ${e.message}`);
    return [];
  }
}

// ---------- resolução de imagem e link final ----------

async function buscarComTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        "Accept-Language": "pt-BR,pt;q=0.9"
      }
    });
  } finally { clearTimeout(timer); }
}

function extrairOgImage(html) {
  const m = html.match(/<meta[^>]+(?:property|name)=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image(?::secure_url)?["']/i);
  const url = m ? decodificarEntidades(m[1]).trim() : "";
  return /^https?:\/\//i.test(url) ? url : "";
}

function extrairDestinoInterstitial(html) {
  // Página intermediária do Google News: pega a primeira URL externa plausível
  const m = html.match(/https?:\/\/(?!(?:[a-z0-9-]+\.)*(?:google|gstatic|googleusercontent|youtube)\.[a-z.]+\/)[a-z0-9][^"'<>\\ ]{10,300}/i);
  return m ? decodificarEntidades(m[0]) : "";
}

/** Tenta resolver link final + imagem de capa. Nunca lança erro. */
async function resolverArtigo(item) {
  try {
    const r1 = await buscarComTimeout(item.link, 8000);
    const html1 = await r1.text();
    const urlFinal1 = r1.url || item.link;

    if (!/news\.google\.com/i.test(urlFinal1)) {
      item.link = urlFinal1;
      item.imagem = extrairOgImage(html1);
      return;
    }
    // Ainda no interstitial do Google: tenta achar o destino no HTML
    const destino = extrairDestinoInterstitial(html1);
    if (destino) {
      const r2 = await buscarComTimeout(destino, 8000);
      const html2 = await r2.text();
      item.link = r2.url || destino;
      item.imagem = extrairOgImage(html2);
    }
  } catch {
    /* mantém link original e sem imagem — fallback assume */
  }
}

async function resolverTodos(itens) {
  const LOTE = 3;
  for (let i = 0; i < itens.length; i += LOTE) {
    await Promise.all(itens.slice(i, i + LOTE).map(resolverArtigo));
  }
}

// ---------- filtragem e classificação ----------

function pontuar(item) {
  const texto = (item.titulo + " " + item.resumo).toLowerCase();
  let pontos = 0;
  for (const p of PALAVRAS_CHAVE) {
    if (texto.includes(p)) pontos += item.titulo.toLowerCase().includes(p) ? 3 : 1;
  }
  return pontos;
}

function classificar(item) {
  const texto = (item.titulo + " " + item.resumo).toLowerCase();
  let melhor = { nome: "Panorama", cor: "neutro" }, max = 0;
  for (const cat of CATEGORIAS) {
    const acertos = cat.termos.filter(t => texto.includes(t)).length;
    if (acertos > max) { max = acertos; melhor = cat; }
  }
  return melhor;
}

// ---------- geração de HTML ----------

function slugAncora(nome) {
  return nome.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function htmlBoletim({ dataIso, dataExtenso, numeroEdicao, grupos, totalItens }) {
  const chips = grupos.map(g =>
    `<a class="chip chip--${g.cor}" href="#${slugAncora(g.nome)}">${escaparHtml(g.nome)} <span>${g.itens.length}</span></a>`
  ).join("\n      ");

  const secoes = grupos.map(g => {
    const cards = g.itens.map(item => {
      // Google News anexa " - Fonte" ao título; remove para não duplicar com o rótulo
      let titulo = item.titulo;
      if (item.fonte && titulo.toLowerCase().endsWith(("- " + item.fonte).toLowerCase())) {
        titulo = titulo.slice(0, -(item.fonte.length + 2)).trim();
      }
      const capa = item.imagem
        ? escaparHtml(item.imagem)
        : `../assets/capa-${g.cor}.svg`;
      return `
        <article class="card">
          <a class="card__capa" href="${escaparHtml(item.link)}" target="_blank" rel="noopener">
            <img src="${capa}" alt="" loading="lazy" onerror="this.onerror=null;this.src='../assets/capa-${g.cor}.svg'">
          </a>
          <div class="card__corpo">
            <p class="card__fonte">${escaparHtml(item.fonte || "Fonte não informada")}</p>
            <h3 class="card__titulo"><a href="${escaparHtml(item.link)}" target="_blank" rel="noopener">${escaparHtml(titulo)}</a></h3>
            ${item.resumo ? `<p class="card__resumo">${escaparHtml(item.resumo.slice(0, 160))}${item.resumo.length > 160 ? "…" : ""}</p>` : ""}
          </div>
        </article>`;
    }).join("\n");
    return `
      <section id="${slugAncora(g.nome)}" class="secao secao--${g.cor}">
        <h2>${escaparHtml(g.nome)}</h2>
        <div class="grade">
${cards}
        </div>
      </section>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Boletim nº ${numeroEdicao} · ${dataExtenso} — Inclusão Digital em Pauta</title>
<meta name="description" content="Boletim diário de notícias sobre inclusão digital no Brasil — edição de ${dataExtenso}.">
<link rel="stylesheet" href="../assets/estilo.css">
</head>
<body>
<header class="topo">
  <a class="topo__marca" href="../index.html">Inclusão Digital <em>em Pauta</em></a>
  <p class="topo__edicao">Edição nº ${numeroEdicao} · ${dataExtenso} · ${totalItens} matérias</p>
</header>
<main class="boletim">
  <nav class="chips" aria-label="Seções do boletim">
      ${chips}
  </nav>
${secoes}
</main>
<footer class="rodape">
  <p>Curadoria automática diária via feeds públicos. Os títulos levam à fonte original.</p>
  <p><a href="../index.html">← Todas as edições</a></p>
</footer>
</body>
</html>
`;
}

function htmlIndex(boletins) {
  const lista = boletins.map(b => `
      <li class="edicao">
        <a href="posts/${b.arquivo}">
          <span class="edicao__numero">Nº ${b.numero}</span>
          <span class="edicao__data">${escaparHtml(b.dataExtenso)}</span>
          <span class="edicao__contagem">${b.total} matérias</span>
        </a>
      </li>`).join("\n");

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Inclusão Digital em Pauta — boletim diário</title>
<meta name="description" content="Boletim diário automático com as principais notícias sobre inclusão digital, alfabetização digital e conectividade no Brasil.">
<link rel="stylesheet" href="assets/estilo.css">
</head>
<body>
<header class="capa">
  <p class="capa__eyebrow">Boletim diário · publicação automática</p>
  <h1>Inclusão Digital <em>em Pauta</em></h1>
  <p class="capa__tese">Toda manhã, as notícias que importam sobre alfabetização digital, políticas públicas e acesso à internet no Brasil — reunidas em uma edição.</p>
</header>
<main>
  <ul class="edicoes">
${lista || '      <li class="edicoes__vazio">Nenhuma edição publicada ainda. A primeira sai na próxima execução do robô.</li>'}
  </ul>
</main>
<footer class="rodape">
  <p>Projeto de custo zero: GitHub Pages + GitHub Actions + feeds RSS públicos.</p>
</footer>
</body>
</html>
`;
}

// ---------- fluxo principal ----------

(async function principal() {
  const agora = new Date();
  const dataIso = agora.toISOString().slice(0, 10);
  const dataExtenso = agora.toLocaleDateString("pt-BR",
    { day: "numeric", month: "long", year: "numeric", timeZone: "America/Sao_Paulo" });

  const publicados = lerJson(ARQ_PUBLICADOS, []);
  const jaPublicado = new Set(publicados);

  // 1. Coleta
  let itens = [];
  for (const consulta of CONSULTAS) {
    itens = itens.concat(await buscarRss(consulta));
  }
  console.log(`Coletados: ${itens.length} itens brutos`);

  // 2. Filtros
  const limite = agora.getTime() - JANELA_HORAS * 3600 * 1000;
  const vistos = new Set();
  itens = itens.filter(item => {
    const chave = normalizarUrl(item.link);
    const tituloNorm = item.titulo.toLowerCase().replace(/\s+/g, " ");
    if (vistos.has(chave) || vistos.has(tituloNorm)) return false;
    vistos.add(chave); vistos.add(tituloNorm);
    if (jaPublicado.has(chave) || jaPublicado.has(tituloNorm)) return false;
    item.chaveOriginal = chave;
    item.tituloNorm = tituloNorm;
    if (item.dataPub.getTime() < limite) return false;
    return pontuar(item) > 0;
  });

  // 3. Ranqueia e corta
  itens.sort((a, b) => pontuar(b) - pontuar(a) || b.dataPub - a.dataPub);
  itens = itens.slice(0, MAX_ITENS);
  console.log(`Selecionados: ${itens.length} itens`);

  if (itens.length < MIN_ITENS) {
    console.log("Matérias novas insuficientes. Edição de hoje não publicada.");
    return;
  }

  // 3.5 Resolve link final e imagem de capa de cada matéria
  await resolverTodos(itens);
  const comImagem = itens.filter(i => i.imagem).length;
  console.log(`Imagens resolvidas: ${comImagem}/${itens.length} (demais usam capa da categoria)`);

  // 4. Agrupa por categoria
  const mapa = new Map();
  for (const item of itens) {
    const cat = classificar(item);
    if (!mapa.has(cat.nome)) mapa.set(cat.nome, { nome: cat.nome, cor: cat.cor, itens: [] });
    mapa.get(cat.nome).itens.push(item);
  }
  const grupos = [...mapa.values()].sort((a, b) => b.itens.length - a.itens.length);

  // 5. Gera arquivos
  const boletins = lerJson(ARQ_BOLETINS, []);
  const numeroEdicao = boletins.length + 1;
  const arquivo = `${dataIso}.html`;

  fs.mkdirSync(DIR_POSTS, { recursive: true });
  fs.writeFileSync(path.join(DIR_POSTS, arquivo),
    htmlBoletim({ dataIso, dataExtenso, numeroEdicao, grupos, totalItens: itens.length }), "utf8");

  boletins.unshift({ numero: numeroEdicao, data: dataIso, dataExtenso, arquivo, total: itens.length });
  salvarJson(ARQ_BOLETINS, boletins);

  fs.writeFileSync(path.join(RAIZ, "index.html"), htmlIndex(boletins), "utf8");

  // 6. Atualiza histórico de dedup
  const novos = itens.flatMap(i =>
    [...new Set([i.chaveOriginal, normalizarUrl(i.link), i.tituloNorm])]);
  salvarJson(ARQ_PUBLICADOS, [...novos, ...publicados].slice(0, LIMITE_HISTORICO));

  console.log(`Publicado: posts/${arquivo} (edição nº ${numeroEdicao}, ${itens.length} matérias)`);
})().catch(e => { console.error(e); process.exit(1); });
