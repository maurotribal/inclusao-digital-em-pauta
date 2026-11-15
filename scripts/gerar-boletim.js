/**
 * gerar-boletim.js — Boletim diário de Inclusão Digital (v3)
 * Zero dependências. Node 20+ (fetch nativo).
 *
 * Fluxo:
 *  1. Busca Google News RSS (várias consultas temáticas)
 *  2. Filtra: 48h + palavras-chave + histórico + blocklist + termos negativos
 *  3. Pontua (tema + fonte), seleciona gulosamente:
 *     - descarta matérias semelhantes (mesma notícia em outro título/fonte)
 *     - no máximo N estrangeiras por edição; mesmo domínio estrangeiro
 *       não volta antes de X dias (data/estrangeiros.json)
 *     - no máximo M matérias do mesmo domínio por edição
 *  4. Resolve link real, imagem, resumo (og:description) e data original
 *  5. Gera posts/AAAA-MM-DD.html + index.html (com meta og/twitter)
 *  6. Atualiza data/publicados.json, data/boletins.json, data/estrangeiros.json
 *
 * Ajustes sem mexer no código: data/filtros.json (editável pela web).
 * Se não houver matérias novas suficientes, sai sem publicar (exit 0).
 */

const fs = require("fs");
const path = require("path");

const RAIZ = path.join(__dirname, "..");
const DIR_POSTS = path.join(RAIZ, "posts");
const ARQ_PUBLICADOS = path.join(RAIZ, "data", "publicados.json");
const ARQ_BOLETINS = path.join(RAIZ, "data", "boletins.json");
const ARQ_FILTROS = path.join(RAIZ, "data", "filtros.json");
const ARQ_ESTRANGEIROS = path.join(RAIZ, "data", "estrangeiros.json");

const URL_BASE = "https://maurotribal.github.io/inclusao-digital-em-pauta";
const NOME_SITE = "Inclusão Digital em Pauta";

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
const CATEGORIA_PADRAO = { nome: "Panorama", cor: "neutro" };

// Valores padrão; data/filtros.json sobrescreve chave a chave
const FILTROS_PADRAO = {
  blocklistDominios: ["plantaobrasil.net"],
  allowlistDominios: ["gov.br", "ebc.com.br", "nic.br", "cetic.br", "g1.globo.com", "rnp.br"],
  dominiosNacionais: ["globo.com", "metropoles.com", "cnnbrasil.com.br", "poder360.com.br"],
  termosNegativos: ["litros de água", "economia de água"],
  maxEstrangeirosPorEdicao: 1,
  diasEntreMesmoEstrangeiro: 7,
  maxPorDominio: 2
};

const MAX_ITENS = 10;
const MIN_ITENS = 2;
const JANELA_HORAS = 48;
const LIMITE_HISTORICO = 600;
const TAM_RESUMO = 200;

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
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function limparHtml(s) {
  return decodificarEntidades(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function escaparHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
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

function hostSemWww(u) {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return ""; }
}

function casaDominio(dominio, lista) {
  return lista.some(d => dominio === d || dominio.endsWith("." + d));
}

function cortar(texto, max) {
  if (texto.length <= max) return texto;
  const corte = texto.slice(0, max);
  const esp = corte.lastIndexOf(" ");
  return (esp > max * 0.6 ? corte.slice(0, esp) : corte).replace(/[\s,.;:–-]+$/, "") + "…";
}

function dataSP(d, opcoes) {
  return d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", ...opcoes });
}

function formatarData(d) {
  if (!(d instanceof Date) || isNaN(d)) return "";
  return dataSP(d, { day: "2-digit", month: "2-digit", year: "numeric" }) + " · " +
         dataSP(d, { hour: "2-digit", minute: "2-digit" });
}

function isoDataSP(d) {
  // AAAA-MM-DD no fuso de São Paulo
  const p = dataSP(d, { year: "numeric", month: "2-digit", day: "2-digit" }).split("/");
  return `${p[2]}-${p[1]}-${p[0]}`;
}

// ---------- semelhança de títulos ----------

const STOP = new Set(("a o as os de da do das dos e em no na nos nas um uma uns umas " +
  "para por com sem que se ao aos sobre entre como mais menos seu sua seus suas " +
  "pelo pela pelos pelas sao foi ser ter tem ja nao sim apos ate diz the of and to in for on").split(" "));
// Radicais do próprio tema: aparecem em quase todo título e mascaram a comparação
const RADICAIS_TEMA = new Set(["inclu", "digit", "exclu", "letra", "alfab", "inter", "conec", "tecno"]);

function normalizar(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function radicais(titulo) {
  const out = new Set();
  for (const w of normalizar(titulo).split(/[^a-z0-9]+/)) {
    if (w.length < 3 || STOP.has(w)) continue;
    const r = w.slice(0, 5);
    if (!RADICAIS_TEMA.has(r)) out.add(r);
  }
  return out;
}

/**
 * Palavras com inicial maiúscula (inclui a primeira do título: "Quixabeira
 * recebe..."). Palavras genéricas na abertura ("Programa", "Governo") são
 * contidas porque o casamento ainda exige sobreposição >= 0,4.
 */
function nomesProprios(titulo) {
  const out = new Set();
  for (const w of String(titulo || "").split(/\s+/)) {
    const limpo = w.replace(/[^\p{L}\p{N}]/gu, "");
    if (limpo.length < 4 || !/^\p{Lu}/u.test(limpo)) continue;
    const n = normalizar(limpo);
    if (!STOP.has(n) && !RADICAIS_TEMA.has(n.slice(0, 5))) out.add(n);
  }
  return out;
}

/** Coeficiente de sobreposição: |A∩B| / min(|A|,|B|). 0..1 */
function sobreposicao(a, b) {
  const menor = Math.min(a.size, b.size);
  if (!menor) return 0;
  let comum = 0;
  for (const x of a) if (b.has(x)) comum++;
  return comum / menor;
}

/** Mesma notícia? Regra mais frouxa para o mesmo domínio. */
function semelhantes(a, b) {
  const ov = sobreposicao(a.radicais, b.radicais);
  if (a.dominio && a.dominio === b.dominio) return ov >= 0.5;
  if (ov >= 0.6) return true;
  if (ov >= 0.4) {
    for (const n of a.nomes) if (b.nomes.has(n)) return true;
  }
  return false;
}

// ---------- coleta ----------

async function buscarRss(consulta) {
  const url = "https://news.google.com/rss/search?q=" +
    encodeURIComponent(consulta) + "&hl=pt-BR&gl=BR&ceid=BR:pt-419";
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (BoletimInclusaoDigital/3.0)" }
    });
    if (!resp.ok) { console.warn(`RSS ${consulta}: HTTP ${resp.status}`); return []; }
    const xml = await resp.text();
    const itens = [];
    const blocos = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    for (const bloco of blocos) {
      let titulo = limparHtml(extrairTag(bloco, "title"));
      const link = decodificarEntidades(extrairTag(bloco, "link"));
      const dataPub = new Date(extrairTag(bloco, "pubDate"));
      const fonte = limparHtml(extrairTag(bloco, "source"));
      const urlFonte = (bloco.match(/<source[^>]*\burl="([^"]+)"/i) || [])[1] || "";
      // Google News anexa " - Fonte" ao título
      if (fonte && titulo.toLowerCase().endsWith((" - " + fonte).toLowerCase())) {
        titulo = titulo.slice(0, -(fonte.length + 3)).trim();
      }
      if (titulo && link && !isNaN(dataPub)) {
        itens.push({
          titulo, link, dataPub, fonte,
          dominio: hostSemWww(decodificarEntidades(urlFonte)),
          resumo: "",           // o description do feed só repete o título
          imagem: "", publicadoEm: null
        });
      }
    }
    return itens;
  } catch (e) {
    console.warn(`RSS ${consulta}: ${e.message}`);
    return [];
  }
}

// ---------- resolução de link, imagem, resumo e data ----------

async function buscarComTimeout(url, ms, opcoes = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      ...opcoes,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        "Accept-Language": "pt-BR,pt;q=0.9",
        ...(opcoes.headers || {})
      }
    });
  } finally { clearTimeout(timer); }
}

function metaConteudo(html, nomes) {
  for (const nome of nomes) {
    const n = nome.replace(/:/g, "\\:");
    const re1 = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${n}["'][^>]*content=["']([^"']*)["']`, "i");
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name|itemprop)=["']${n}["']`, "i");
    const m = html.match(re1) || html.match(re2);
    if (m && m[1].trim()) return decodificarEntidades(m[1]).trim();
  }
  return "";
}

/** Extrai {imagem, descricao, publicadoEm} do HTML da matéria. */
function extrairMetaPagina(html) {
  const img = metaConteudo(html, ["og:image:secure_url", "og:image", "twitter:image"]);
  const desc = limparHtml(metaConteudo(html, ["og:description", "description", "twitter:description"]));
  const dataTxt = metaConteudo(html, ["article:published_time", "datePublished", "pubdate", "date"]);
  const data = dataTxt ? new Date(dataTxt) : null;
  return {
    imagem: /^https?:\/\//i.test(img) ? img : "",
    descricao: desc,
    publicadoEm: data && !isNaN(data) ? data : null
  };
}

/** Resumo só vale se acrescentar algo ao título. */
function resumoUtil(resumo, titulo) {
  if (!resumo || resumo.length < 40) return false;
  if (/https?:\/\/|cookies?|assine|cadastre-se/i.test(resumo)) return false;
  return sobreposicao(radicais(resumo), radicais(titulo)) < 0.8;
}

/**
 * Resolve a URL real de um link news.google.com/rss/articles/<id>.
 * A página intermediária traz assinatura (data-n-a-sg) e timestamp
 * (data-n-a-ts); o endpoint interno batchexecute devolve a URL.
 */
async function decodificarLinkGoogleNews(link) {
  const idm = link.match(/\/(?:articles|read)\/([^?/]+)/);
  if (!idm) return "";
  const id = idm[1];

  const r1 = await buscarComTimeout(link, 8000);
  const html = await r1.text();
  if (r1.url && !/news\.google\.com/i.test(r1.url)) return r1.url;

  const sg = (html.match(/data-n-a-sg="([^"]+)"/) || [])[1];
  const ts = (html.match(/data-n-a-ts="([^"]+)"/) || [])[1];
  if (!sg || !ts) return "";

  const req = JSON.stringify([[["Fbv4je",
    `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${id}",${ts},"${sg}"]`,
    null, "generic"]]]);

  const r2 = await buscarComTimeout("https://news.google.com/_/DotsSplashUi/data/batchexecute", 8000, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: "f.req=" + encodeURIComponent(req)
  });
  const texto = await r2.text();
  const m = texto.match(/\[\\?"garturlres\\?",\\?"(https?:[^"\\]+)/);
  return m ? m[1] : "";
}

/** Completa link real, imagem, resumo e data original. Nunca lança erro. */
async function resolverArtigo(item) {
  try {
    const destino = /news\.google\.com/i.test(item.link)
      ? await decodificarLinkGoogleNews(item.link)
      : item.link;
    if (!destino) return;

    item.link = destino;
    const r = await buscarComTimeout(destino, 8000);
    const html = await r.text();
    if (r.url) item.link = r.url;
    if (!item.dominio) item.dominio = hostSemWww(item.link);

    const meta = extrairMetaPagina(html);
    item.imagem = meta.imagem;
    if (resumoUtil(meta.descricao, item.titulo)) item.resumo = cortar(meta.descricao, TAM_RESUMO);
    // Data da página só se for plausível (não futura, não muito antiga)
    if (meta.publicadoEm) {
      const dif = item.dataPub - meta.publicadoEm;
      if (dif > -86400000 && dif < 30 * 86400000) item.publicadoEm = meta.publicadoEm;
    }
  } catch {
    /* mantém o que tiver — fallback assume */
  }
}

async function resolverTodos(itens) {
  const LOTE = 3;
  for (let i = 0; i < itens.length; i += LOTE) {
    await Promise.all(itens.slice(i, i + LOTE).map(resolverArtigo));
  }
}

// ---------- pontuação, filtros e seleção ----------

function pontuarTema(item) {
  const titulo = item.titulo.toLowerCase();
  let pontos = 0;
  for (const p of PALAVRAS_CHAVE) if (titulo.includes(p)) pontos += 3;
  return pontos;
}

function ehEstrangeiro(dominio, filtros) {
  if (!dominio || dominio.endsWith(".br")) return false;
  if (casaDominio(dominio, filtros.dominiosNacionais)) return false;
  const tld = dominio.split(".").pop();
  return tld.length === 2; // ccTLD de outro país (.vn, .pt, .cn ...)
}

function pontuarFonte(dominio, filtros) {
  if (!dominio) return 0;
  if (casaDominio(dominio, filtros.blocklistDominios)) return -Infinity;
  let p = 0;
  if (casaDominio(dominio, filtros.allowlistDominios)) p += 3;
  if (dominio.endsWith(".gov.br") || dominio.endsWith(".jus.br") || dominio.endsWith(".leg.br")) p += 3;
  else if (dominio.endsWith(".br")) p += 2;
  if (ehEstrangeiro(dominio, filtros)) p -= 3;
  return p;
}

function temTermoNegativo(item, filtros) {
  const texto = normalizar(item.titulo);
  return filtros.termosNegativos.some(t => texto.includes(normalizar(t)));
}

/**
 * Seleção gulosa por pontuação. Recebe candidatos já filtrados e ordenados.
 * Retorna { escolhidos, descartes } — descartes só para log.
 */
function selecionar(candidatos, filtros, estrangeirosRecentes, titulosHistorico, hojeIso) {
  const escolhidos = [];
  const descartes = { semelhante: 0, historico: 0, estrangeiro: 0, dominio: 0 };
  const porDominio = {};
  let estrangeirosHoje = 0;
  const limiteRecente = Date.parse(hojeIso) - filtros.diasEntreMesmoEstrangeiro * 86400000;

  for (const c of candidatos) {
    if (escolhidos.length >= MAX_ITENS) break;

    if (escolhidos.some(e => semelhantes(c, e))) { descartes.semelhante++; continue; }
    if (titulosHistorico.some(h => sobreposicao(c.radicais, h) >= 0.6)) { descartes.historico++; continue; }

    if (c.estrangeiro) {
      const ultima = estrangeirosRecentes[c.dominio];
      if (estrangeirosHoje >= filtros.maxEstrangeirosPorEdicao ||
          (ultima && Date.parse(ultima) > limiteRecente)) {
        descartes.estrangeiro++; continue;
      }
    }

    const chaveDom = c.dominio || c.fonte;
    if ((porDominio[chaveDom] || 0) >= filtros.maxPorDominio) { descartes.dominio++; continue; }

    escolhidos.push(c);
    porDominio[chaveDom] = (porDominio[chaveDom] || 0) + 1;
    if (c.estrangeiro) estrangeirosHoje++;
  }
  return { escolhidos, descartes };
}

function classificar(item) {
  const texto = (item.titulo + " " + item.resumo).toLowerCase();
  let melhor = CATEGORIA_PADRAO, max = 0;
  for (const cat of CATEGORIAS) {
    const acertos = cat.termos.filter(t => texto.includes(t)).length;
    if (acertos > max) { max = acertos; melhor = cat; }
  }
  return melhor;
}

// ---------- geração de HTML ----------

function slugAncora(nome) {
  return normalizar(nome).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function metaTags({ titulo, descricao, url, imagem, tipo }) {
  const t = escaparHtml(titulo), d = escaparHtml(descricao);
  const img = escaparHtml(imagem || `${URL_BASE}/assets/og-padrao.png`);
  return `<title>${t}</title>
<meta name="description" content="${d}">
<link rel="canonical" href="${escaparHtml(url)}">
<meta property="og:site_name" content="${escaparHtml(NOME_SITE)}">
<meta property="og:locale" content="pt_BR">
<meta property="og:type" content="${tipo || "website"}">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:url" content="${escaparHtml(url)}">
<meta property="og:image" content="${img}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta name="twitter:image" content="${img}">`;
}

/**
 * Card de matéria. Imagem real quando houver; senão ilustração da categoria
 * com selo do domínio. Mesmo fallback se a imagem real falhar no navegador.
 * variante: "card" | "manchete"
 */
function cardHtml(item, prefixo, variante) {
  const cor = item.cor || "neutro";
  const reserva = `${prefixo}assets/capa-${cor}.svg`;
  const temImg = !!item.imagem;
  const data = item.publicadoEm || item.dataPub;
  const dataTxt = item.dataTxt || formatarData(data instanceof Date ? data : new Date(data));
  const dataIso = (data instanceof Date ? data : new Date(data));
  const classeBase = variante === "manchete" ? "manchete" : "card";
  const link = escaparHtml(item.link);

  return `
        <article class="${classeBase}">
          <a class="card__capa${temImg ? "" : " card__capa--reserva"}" href="${link}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true">
            <img src="${temImg ? escaparHtml(item.imagem) : reserva}" alt="" loading="lazy"
                 onerror="this.onerror=null;this.src='${reserva}';this.parentNode.classList.add('card__capa--reserva')">
            <span class="card__tag card__tag--${cor}">${escaparHtml(item.categoria || CATEGORIA_PADRAO.nome)}</span>
            <span class="card__selo">${escaparHtml(item.dominio || item.fonte || "")}</span>
          </a>
          <div class="card__corpo">
            <p class="card__meta"><span class="card__fonte">${escaparHtml(item.fonte || "Fonte não informada")}</span>${dataTxt ? `<time datetime="${isNaN(dataIso) ? "" : dataIso.toISOString()}">${dataTxt}</time>` : ""}</p>
            <h3 class="card__titulo"><a href="${link}" target="_blank" rel="noopener">${escaparHtml(item.titulo)}</a></h3>
            ${item.resumo ? `<p class="card__resumo">${escaparHtml(item.resumo)}</p>` : ""}
          </div>
        </article>`;
}

/** Versão do CSS (8 primeiros caracteres do hash do conteúdo). Muda quando o arquivo muda,
 *  e o navegador do visitante baixa o CSS novo na hora em vez de usar o guardado em cache. */
let _versaoCss = null;
function versaoCss() {
  if (_versaoCss === null) {
    try {
      _versaoCss = require("crypto").createHash("md5")
        .update(fs.readFileSync(path.join(RAIZ, "assets", "estilo.css"))).digest("hex").slice(0, 8);
    } catch { _versaoCss = String(Date.now()); }
  }
  return _versaoCss;
}

function cabecalhoSite(prefixo) {
  return `<div class="barra">
  <header class="topo">
    <a class="topo__marca" href="${prefixo}index.html">Inclusão Digital <em>em Pauta</em></a>
    <nav class="topo__nav"><a href="${prefixo}index.html#edicoes">Edições</a></nav>
  </header>
</div>`;
}

function rodapeSite(prefixo) {
  return `<footer class="rodape">
  <p>Curadoria automática diária a partir de feeds públicos. Títulos e imagens pertencem às fontes originais e levam até elas. Imagens marcadas com o nome do site são ilustrações do boletim.</p>
  <p><a href="${prefixo}index.html#edicoes">Todas as edições</a></p>
</footer>`;
}

function htmlBoletim({ dataIso, dataExtenso, numeroEdicao, manchete, grupos, totalItens, horaGeracao }) {
  const chips = grupos.map(g =>
    `<a class="chip chip--${g.cor}" href="#${slugAncora(g.nome)}">${escaparHtml(g.nome)} <span>${g.itens.length}</span></a>`
  ).join("\n      ");

  const secoes = grupos.map(g => `
  <section id="${slugAncora(g.nome)}" class="secao secao--${g.cor}">
    <h2>${escaparHtml(g.nome)}</h2>
    <div class="grade">
${g.itens.map(i => cardHtml(i, "../", "card")).join("\n")}
    </div>
  </section>`).join("\n");

  const url = `${URL_BASE}/posts/${dataIso}.html`;
  const descricao = `Edição nº ${numeroEdicao} (${dataExtenso}): ${manchete.titulo}`;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${metaTags({
  titulo: `Boletim nº ${numeroEdicao} · ${dataExtenso} — ${NOME_SITE}`,
  descricao: cortar(descricao, 200),
  url, imagem: manchete.imagem, tipo: "article"
})}
<link rel="stylesheet" href="../assets/estilo.css?v=${versaoCss()}">
</head>
<body>
${cabecalhoSite("../")}
<main class="boletim">
  <div class="edicao-cabecalho">
    <p class="sobretitulo">Edição nº ${numeroEdicao}</p>
    <h1>${escaparHtml(dataExtenso)}</h1>
    <p class="edicao-cabecalho__info">${totalItens} matérias selecionadas · gerado às ${horaGeracao}</p>
    <nav class="chips" aria-label="Seções do boletim">
      ${chips}
    </nav>
  </div>
${cardHtml(manchete, "../", "manchete")}
${secoes}
</main>
${rodapeSite("../")}
</body>
</html>
`;
}

// A capa (index.html) é gerada por scripts/gerar-capa.js.
// Require tardio: gerar-capa.js importa este arquivo.
async function gerarCapa(novas) {
  try { await require("./gerar-capa.js").gerarCapa(novas); }
  catch (e) { console.error("Falha ao gerar a capa:", e.message); }
}

// ---------- fluxo principal ----------

async function principal() {
  const agora = new Date();
  const dataIso = isoDataSP(agora);
  const dataExtenso = dataSP(agora, { day: "numeric", month: "long", year: "numeric" });
  const horaGeracao = dataSP(agora, { hour: "2-digit", minute: "2-digit" });

  const filtros = { ...FILTROS_PADRAO, ...lerJson(ARQ_FILTROS, {}) };
  const publicados = lerJson(ARQ_PUBLICADOS, []);
  const jaPublicado = new Set(publicados);
  const titulosHistorico = publicados.filter(p => !/^https?:/.test(p)).map(radicais);
  const estrangeirosRecentes = lerJson(ARQ_ESTRANGEIROS, {});

  // Edição do dia já publicada: não refaz (evita trocar matérias já no ar), só atualiza a capa
  if (lerJson(ARQ_BOLETINS, []).some(b => b.data === dataIso)) {
    console.log(`Edição de ${dataIso} já publicada. Só a capa será regenerada.`);
    await gerarCapa();
    return;
  }

  // 1. Coleta
  let itens = [];
  for (const consulta of CONSULTAS) itens = itens.concat(await buscarRss(consulta));
  console.log(`Coletados: ${itens.length} itens brutos`);

  // 2. Filtros duros
  const limite = agora.getTime() - JANELA_HORAS * 3600 * 1000;
  const vistos = new Set();
  const bloqueio = { blocklist: 0, negativo: 0 };
  itens = itens.filter(item => {
    const chave = normalizarUrl(item.link);
    const tituloNorm = item.titulo.toLowerCase().replace(/\s+/g, " ");
    if (vistos.has(chave) || vistos.has(tituloNorm)) return false;
    vistos.add(chave); vistos.add(tituloNorm);
    if (jaPublicado.has(chave) || jaPublicado.has(tituloNorm)) return false;
    if (item.dataPub.getTime() < limite) return false;
    if (pontuarTema(item) === 0) return false;
    if (temTermoNegativo(item, filtros)) { bloqueio.negativo++; return false; }
    const pf = pontuarFonte(item.dominio, filtros);
    if (pf === -Infinity) { bloqueio.blocklist++; return false; }

    item.chaveOriginal = chave;
    item.tituloNorm = tituloNorm;
    item.radicais = radicais(item.titulo);
    item.nomes = nomesProprios(item.titulo);
    item.estrangeiro = ehEstrangeiro(item.dominio, filtros);
    item.pontos = pontuarTema(item) + pf;
    return true;
  });
  console.log(`Após filtros: ${itens.length} (blocklist ${bloqueio.blocklist}, termos negativos ${bloqueio.negativo})`);

  // 3. Ordena e seleciona
  itens.sort((a, b) => b.pontos - a.pontos || b.dataPub - a.dataPub);
  const { escolhidos, descartes } = selecionar(itens, filtros, estrangeirosRecentes, titulosHistorico, dataIso);
  console.log(`Selecionados: ${escolhidos.length} | descartes: semelhantes ${descartes.semelhante}, ` +
    `já noticiados ${descartes.historico}, estrangeiros ${descartes.estrangeiro}, excesso por domínio ${descartes.dominio}`);

  if (escolhidos.length < MIN_ITENS) {
    console.log("Matérias novas insuficientes. Edição de hoje não publicada.");
    await gerarCapa();
    return;
  }

  // 4. Resolve link, imagem, resumo e data original
  await resolverTodos(escolhidos);
  const comImagem = escolhidos.filter(i => i.imagem).length;
  const comResumo = escolhidos.filter(i => i.resumo).length;
  console.log(`Imagens: ${comImagem}/${escolhidos.length} | resumos: ${comResumo}/${escolhidos.length}`);

  for (const i of escolhidos) {
    const cat = classificar(i);
    i.categoria = cat.nome;
    i.cor = cat.cor;
    i.dataTxt = formatarData(i.publicadoEm || i.dataPub);
  }

  // Manchete: maior pontuação, com preferência para quem tem imagem real
  const idxManchete = Math.max(0, escolhidos.findIndex(i => i.imagem));
  const manchete = escolhidos[idxManchete] && escolhidos[idxManchete].imagem
    ? escolhidos[idxManchete] : escolhidos[0];
  const demais = escolhidos.filter(i => i !== manchete);

  const mapa = new Map();
  for (const item of demais) {
    if (!mapa.has(item.categoria)) mapa.set(item.categoria, { nome: item.categoria, cor: item.cor, itens: [] });
    mapa.get(item.categoria).itens.push(item);
  }
  const grupos = [...mapa.values()].sort((a, b) => b.itens.length - a.itens.length);

  // 5. Gera arquivos
  const boletins = lerJson(ARQ_BOLETINS, []);
  const numeroEdicao = boletins.length ? Math.max(...boletins.map(b => b.numero || 0)) + 1 : 1;
  const arquivo = `${dataIso}.html`;

  fs.mkdirSync(DIR_POSTS, { recursive: true });
  fs.writeFileSync(path.join(DIR_POSTS, arquivo),
    htmlBoletim({ dataIso, dataExtenso, numeroEdicao, manchete, grupos, totalItens: escolhidos.length, horaGeracao }), "utf8");

  const destaques = [manchete, ...demais].slice(0, 4).map(i => ({
    titulo: i.titulo, link: i.link, imagem: i.imagem, fonte: i.fonte, dominio: i.dominio,
    resumo: i.resumo, categoria: i.categoria, cor: i.cor,
    dataPub: (i.publicadoEm || i.dataPub).toISOString(), dataTxt: i.dataTxt
  }));
  boletins.unshift({ numero: numeroEdicao, data: dataIso, dataExtenso, arquivo, total: escolhidos.length, destaques });
  salvarJson(ARQ_BOLETINS, boletins);

  // Capa estilo portal: notícias desta edição entram no topo de data/noticias.json
  await gerarCapa([manchete, ...demais].map(i => ({
    titulo: i.titulo, link: i.link, imagem: i.imagem, fonte: i.fonte, dominio: i.dominio,
    resumo: i.resumo, categoria: i.categoria, cor: i.cor,
    data: (i.publicadoEm || i.dataPub).toISOString(), edicao: numeroEdicao, arquivo
  })));

  // 6. Históricos
  const novos = escolhidos.flatMap(i =>
    [...new Set([i.chaveOriginal, normalizarUrl(i.link), i.tituloNorm])]);
  salvarJson(ARQ_PUBLICADOS, [...novos, ...publicados].slice(0, LIMITE_HISTORICO));

  const corte30 = Date.parse(dataIso) - 30 * 86400000;
  for (const [dom, dia] of Object.entries(estrangeirosRecentes)) {
    if (Date.parse(dia) < corte30) delete estrangeirosRecentes[dom];
  }
  for (const i of escolhidos) if (i.estrangeiro && i.dominio) estrangeirosRecentes[i.dominio] = dataIso;
  salvarJson(ARQ_ESTRANGEIROS, estrangeirosRecentes);

  console.log(`Publicado: posts/${arquivo} (edição nº ${numeroEdicao}, ${escolhidos.length} matérias)`);
}

// Exporta ANTES de executar: gerar-capa.js importa este arquivo durante a execução,
// e precisa encontrar as funções já disponíveis (Object.assign mantém a mesma referência).
Object.assign(module.exports, {
  radicais, nomesProprios, sobreposicao, semelhantes, ehEstrangeiro, pontuarFonte,
  temTermoNegativo, selecionar, extrairMetaPagina, resumoUtil, formatarData, cortar,
  FILTROS_PADRAO, principal,
  // usados por gerar-capa.js
  escaparHtml, limparHtml, decodificarEntidades, normalizar, metaTags,
  cabecalhoSite, rodapeSite, lerJson, salvarJson, URL_BASE, NOME_SITE, versaoCss
});

if (require.main === module) {
  principal().catch(e => { console.error(e); process.exit(1); });
}
