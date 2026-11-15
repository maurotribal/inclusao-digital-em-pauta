/**
 * gerar-capa.js — Capa estilo portal de notícias (v4)
 *
 * Lê data/noticias.json (notícias das edições recentes) e data/boletins.json
 * e gera index.html com:
 *   1. Destaque principal (foto grande com título sobreposto)
 *   2. Coluna "Últimas" (lista com fonte e data)
 *   3. Faixa de 4 destaques secundários com foto
 *   4. Blocos por categoria (1 notícia com foto + manchetes em texto)
 *   5. "Mais notícias" (cards compactos)
 *   6. Edições anteriores (compacto)
 *
 * Se data/noticias.json estiver vazio, preenche lendo as páginas já
 * publicadas em posts/ (backfill), para a capa nascer cheia.
 *
 * Uso: chamado pelo gerar-boletim.js ao final de cada execução,
 * ou direto: node scripts/gerar-capa.js
 */

const fs = require("fs");
const path = require("path");
const B = require("./gerar-boletim.js");

const RAIZ = path.join(__dirname, "..");
const DIR_POSTS = path.join(RAIZ, "posts");
const ARQ_NOTICIAS = path.join(RAIZ, "data", "noticias.json");
const ARQ_BOLETINS = path.join(RAIZ, "data", "boletins.json");

const LIMITE_NOTICIAS = 150;
const EDICOES_BACKFILL = 30;

const CATEGORIAS_CAPA = [
  { nome: "Políticas Públicas", cor: "amarelo" },
  { nome: "Educação Digital", cor: "ciano" },
  { nome: "Acesso e Conectividade", cor: "verde" },
  { nome: "Panorama", cor: "neutro" }
];
const COR_POR_NOME = Object.fromEntries(CATEGORIAS_CAPA.map(c => [c.nome, c.cor]));

const esc = B.escaparHtml;

// ---------- backfill: lê notícias das páginas já publicadas ----------

function textoDe(html, re) {
  const m = html.match(re);
  return m ? B.limparHtml(m[1]) : "";
}

/** Extrai notícias de uma página de edição (markup v1, v2 ou v3). */
function lerEdicaoHtml(html, edicao) {
  const itens = [];
  // pedaço antes da primeira seção (manchete v3) + cada seção
  const partes = html.split(/<section\b/i);
  partes.forEach((parte, idx) => {
    let catNome = "", catCor = "";
    if (idx > 0) {
      catCor = (parte.match(/class="secao secao--(\w+)"/) || [])[1] || "";
      catNome = textoDe(parte, /<h2>([\s\S]*?)<\/h2>/);
    }
    const artigos = parte.match(/<article class="(?:card|manchete)">[\s\S]*?<\/article>/g) || [];
    for (const a of artigos) {
      const titulo = textoDe(a, /class="card__titulo"><a[^>]*>([\s\S]*?)<\/a>/);
      const link = B.decodificarEntidades((a.match(/href="([^"]+)"/) || [])[1] || "");
      if (!titulo || !/^https?:/.test(link)) continue;

      let imagem = B.decodificarEntidades((a.match(/<img src="([^"]+)"/) || [])[1] || "");
      if (!/^https?:/.test(imagem) || /assets\/capa-/.test(imagem)) imagem = "";

      const fonte = textoDe(a, /class="card__fonte">([\s\S]*?)<\/(?:p|span)>/);
      let resumo = textoDe(a, /class="card__resumo">([\s\S]*?)<\/p>/);
      // edições antigas: "resumo" era só título + fonte
      const nt = B.normalizar(titulo).slice(0, 40);
      if (resumo && B.normalizar(resumo).startsWith(nt)) resumo = "";

      const tag = a.match(/card__tag card__tag--(\w+)">([\s\S]*?)<\/span>/);
      const categoria = tag ? B.limparHtml(tag[2]) : (catNome || "Panorama");
      const cor = tag ? tag[1] : (catCor || COR_POR_NOME[categoria] || "neutro");

      const dt = (a.match(/<time datetime="([^"]+)"/) || [])[1];
      // sem <time> (edições antigas): só a data da edição, sem horário inventado
      const data = dt && !isNaN(new Date(dt)) ? new Date(dt).toISOString() : edicao.data;

      itens.push({ titulo, link, imagem, fonte, dominio: "", resumo, categoria, cor, data,
                   edicao: edicao.numero, arquivo: edicao.arquivo });
    }
  });
  return itens;
}

function backfill(boletins) {
  const itens = [];
  for (const ed of boletins.slice(0, EDICOES_BACKFILL)) {
    try {
      const html = fs.readFileSync(path.join(DIR_POSTS, ed.arquivo), "utf8");
      itens.push(...lerEdicaoHtml(html, ed));
    } catch { /* edição sem arquivo: ignora */ }
  }
  return itens;
}

function mesclar(...listas) {
  const vistos = new Set();
  const out = [];
  for (const lista of listas) for (const n of lista) {
    const k = (n.link || "").toLowerCase();
    if (!k || vistos.has(k)) continue;
    vistos.add(k);
    out.push(n);
  }
  return out.sort((a, b) => (b.edicao || 0) - (a.edicao || 0) || new Date(b.data) - new Date(a.data))
            .slice(0, LIMITE_NOTICIAS);
}

const MAX_ESTRANGEIRAS_CAPA = 3;

/**
 * Aplica à capa os mesmos critérios do robô (edições antigas não passaram por eles):
 * bloqueio, termos negativos, mesma notícia repetida, 1 por site estrangeiro.
 * Recebe lista já ordenada da mais nova para a mais antiga.
 */
function filtrarParaCapa(noticias) {
  const filtros = { ...B.FILTROS_PADRAO, ...B.lerJson(path.join(RAIZ, "data", "filtros.json"), {}) };
  const aceitas = [];
  const sitesEstrangeiros = new Set();
  let descartes = 0;
  for (const n of noticias) {
    const dominio = n.dominio || (() => {
      try { return new URL(n.link).hostname.replace(/^www\./, ""); } catch { return ""; }
    })();
    if (B.pontuarFonte(dominio, filtros) === -Infinity || B.temTermoNegativo(n, filtros)) { descartes++; continue; }

    const cand = { dominio, radicais: B.radicais(n.titulo), nomes: B.nomesProprios(n.titulo) };
    if (aceitas.some(a => B.semelhantes(cand, a.cmp))) { descartes++; continue; }

    if (B.ehEstrangeiro(dominio, filtros)) {
      if (sitesEstrangeiros.has(dominio) || sitesEstrangeiros.size >= MAX_ESTRANGEIRAS_CAPA) { descartes++; continue; }
      sitesEstrangeiros.add(dominio);
    }
    aceitas.push({ n, cmp: cand });
  }
  if (descartes) console.log(`Capa: ${descartes} notícias antigas filtradas (bloqueio, repetidas ou estrangeiras)`);
  return aceitas.map(a => a.n);
}

// ---------- formatação ----------

function dataCurta(iso) {
  const hoje = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const soData = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (soData) {
    const [, a, m, d] = soData;
    return `${d}/${m}/${a}` === hoje ? "Hoje" : `${d}/${m}`;
  }
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const dia = d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  if (dia === hoje) {
    return "Hoje, " + d.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" });
}

function capa(n) {
  return n.imagem ? esc(n.imagem) : `assets/capa-${n.cor || "neutro"}.svg`;
}

function img(n, extraClasse) {
  const reserva = `assets/capa-${n.cor || "neutro"}.svg`;
  return `<img class="${extraClasse || ""}" src="${capa(n)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${reserva}'">`;
}

function meta(n) {
  const d = dataCurta(n.data);
  return `<span class="p-meta"><span class="p-fonte">${esc(n.fonte || n.dominio || "")}</span>${d ? `<time datetime="${esc(n.data)}">${d}</time>` : ""}</span>`;
}

function tag(n) {
  return `<span class="card__tag card__tag--${n.cor || "neutro"}">${esc(n.categoria || "Panorama")}</span>`;
}

const alvo = n => `href="${esc(n.link)}" target="_blank" rel="noopener"`;

// ---------- blocos da capa ----------

function heroHtml(n) {
  return `
    <article class="p-hero">
      <a class="p-hero__link" ${alvo(n)}>
        ${img(n, "p-hero__img")}
        <span class="p-hero__sombra"></span>
        <span class="p-hero__texto">
          ${tag(n)}
          <span class="p-hero__titulo">${esc(n.titulo)}</span>
          ${n.resumo ? `<span class="p-hero__resumo">${esc(B.cortar(n.resumo, 180))}</span>` : ""}
          ${meta(n)}
        </span>
      </a>
    </article>`;
}

function ultimasHtml(lista) {
  return `
    <aside class="p-ultimas" aria-label="Últimas notícias">
      <h2 class="p-titulo-bloco">Últimas</h2>
      <ol>
${lista.map(miniHtml).join("\n")}
      </ol>
    </aside>`;
}

/** Item de lista com miniatura pequena à esquerda (estilo coluna lateral de portal). */
function miniHtml(n) {
  return `        <li class="p-mini">
          <a class="p-mini__capa" ${alvo(n)} tabindex="-1" aria-hidden="true">${img(n)}</a>
          <div>
            <a class="p-mini__titulo" ${alvo(n)}>${esc(n.titulo)}</a>
            ${meta(n)}
          </div>
        </li>`;
}

function cardFotoHtml(n) {
  return `
      <article class="p-card">
        <a class="p-card__capa" ${alvo(n)} tabindex="-1" aria-hidden="true">${img(n)}${tag(n)}</a>
        ${meta(n)}
        <h3><a ${alvo(n)}>${esc(n.titulo)}</a></h3>
      </article>`;
}

function blocoCategoriaHtml(cat, lista) {
  if (!lista.length) return "";
  const [principal, ...resto] = lista;
  return `
    <section class="p-bloco p-bloco--${cat.cor}">
      <h2 class="p-titulo-bloco">${esc(cat.nome)}</h2>
      <article class="p-bloco__principal">
        <a class="p-card__capa" ${alvo(principal)} tabindex="-1" aria-hidden="true">${img(principal)}</a>
        ${meta(principal)}
        <h3><a ${alvo(principal)}>${esc(principal.titulo)}</a></h3>
      </article>
      ${resto.length ? `<ul class="p-bloco__lista">
${resto.map(miniHtml).join("\n")}
      </ul>` : ""}
    </section>`;
}

function compactoHtml(n) {
  return `
      <article class="p-compacto">
        <a class="p-compacto__capa" ${alvo(n)} tabindex="-1" aria-hidden="true">${img(n)}</a>
        <div>
          ${meta(n)}
          <h3><a ${alvo(n)}>${esc(n.titulo)}</a></h3>
        </div>
      </article>`;
}

function edicoesHtml(boletins) {
  const recentes = boletins.slice(0, 12);
  const antigas = boletins.slice(12);
  const item = b => `<li class="edicao"><a href="posts/${b.arquivo}"><span class="edicao__numero">Nº ${b.numero}</span><span class="edicao__data">${esc(b.dataExtenso)}</span><span class="edicao__contagem">${b.total} matérias</span></a></li>`;
  return `
  <section class="arquivo" id="edicoes">
    <h2 class="p-titulo-bloco">Edições anteriores</h2>
    <ul class="edicoes">
${recentes.map(item).join("\n")}
    </ul>
    ${antigas.length ? `<details class="p-mais-edicoes">
      <summary>Ver todas as ${boletins.length} edições</summary>
      <ul class="edicoes">
${antigas.map(item).join("\n")}
      </ul>
    </details>` : ""}
  </section>`;
}

// ---------- montagem ----------

function montarCapa(noticias, boletins) {
  const usadas = new Set();
  const pegar = (filtro, qtd) => {
    const out = [];
    for (const n of noticias) {
      if (out.length >= qtd) break;
      if (usadas.has(n.link) || !filtro(n)) continue;
      usadas.add(n.link);
      out.push(n);
    }
    return out;
  };
  const comFoto = n => !!n.imagem;
  const qualquer = () => true;

  const ultimaEd = boletins[0] ? boletins[0].numero : null;
  const daUltima = n => n.edicao === ultimaEd;

  // Destaque: notícia com foto da edição mais recente; senão, a mais recente com foto
  const hero = pegar(n => daUltima(n) && comFoto(n), 1)[0] || pegar(comFoto, 1)[0] || pegar(qualquer, 1)[0];
  const ultimas = pegar(qualquer, 7);
  const secundarias = [...pegar(comFoto, 4)];
  if (secundarias.length < 4) secundarias.push(...pegar(qualquer, 4 - secundarias.length));

  const blocos = CATEGORIAS_CAPA.map(cat => {
    const daCat = n => n.categoria === cat.nome;
    const principal = pegar(n => daCat(n) && comFoto(n), 1);
    const lista = principal.length ? principal : pegar(daCat, 1);
    lista.push(...pegar(daCat, 4));
    return blocoCategoriaHtml(cat, lista);
  }).join("");

  const mais = pegar(qualquer, 12);
  return { hero, ultimas, secundarias, blocos, mais };
}

function htmlCapa(noticias, boletins) {
  const { hero, ultimas, secundarias, blocos, mais } = montarCapa(noticias, boletins);
  const ultima = boletins[0];
  const hoje = new Date().toLocaleDateString("pt-BR",
    { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "America/Sao_Paulo" });

  const conteudo = hero ? `
  <div class="p-topo-grade">
${heroHtml(hero)}
${ultimasHtml(ultimas)}
  </div>

  ${secundarias.length ? `<div class="p-faixa">
${secundarias.map(cardFotoHtml).join("\n")}
  </div>` : ""}

  ${blocos ? `<div class="p-blocos">${blocos}
  </div>` : ""}

  ${mais.length ? `<section class="p-mais">
    <h2 class="p-titulo-bloco">Mais notícias</h2>
    <div class="p-mais__grade">
${mais.map(compactoHtml).join("\n")}
    </div>
  </section>` : ""}` : `
  <p class="edicoes__vazio">Nenhuma notícia publicada ainda. A primeira edição sai na próxima execução do robô.</p>`;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${B.metaTags({
  titulo: `${B.NOME_SITE} — notícias sobre inclusão digital no Brasil`,
  descricao: hero ? B.cortar(`Hoje: ${hero.titulo}`, 200)
    : "Boletim diário automático com as principais notícias sobre inclusão digital no Brasil.",
  url: `${B.URL_BASE}/`,
  imagem: hero && hero.imagem
})}
<link rel="stylesheet" href="assets/estilo.css">
</head>
<body class="portal">
${B.cabecalhoSite("")}
<div class="p-faixa-data">
  <div>
    <span class="p-faixa-data__hoje">${esc(hoje)}</span>
    ${ultima ? `<a href="posts/${ultima.arquivo}">Edição nº ${ultima.numero} · ${ultima.total} matérias →</a>` : ""}
  </div>
</div>
<main class="p-principal">
${conteudo}
${edicoesHtml(boletins)}
</main>
${B.rodapeSite("")}
</body>
</html>
`;
}

/** Ponto de entrada. novas: notícias da edição recém-gerada (opcional). */
function gerarCapa(novas) {
  const boletins = B.lerJson(ARQ_BOLETINS, []);
  let noticias = B.lerJson(ARQ_NOTICIAS, []);
  let origem = "data/noticias.json";
  if (noticias.length < 12) {
    noticias = mesclar(noticias, backfill(boletins));
    origem = "backfill das páginas publicadas";
  }
  noticias = mesclar(novas || [], noticias);
  B.salvarJson(ARQ_NOTICIAS, noticias);
  fs.writeFileSync(path.join(RAIZ, "index.html"), htmlCapa(filtrarParaCapa(noticias), boletins), "utf8");
  console.log(`Capa gerada: ${noticias.length} notícias (${origem}), ${boletins.length} edições`);
}

if (require.main === module) gerarCapa();

module.exports = { gerarCapa, lerEdicaoHtml, montarCapa };
