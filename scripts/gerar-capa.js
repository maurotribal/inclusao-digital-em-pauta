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

// ---------- fontes parceiras (blogs Blogger) ----------
//
// data/fontes-parceiras.json: [{ "nome", "url", "rotulo", "quantidade" }]
// O robô grava os posts no HTML (funciona sem JavaScript) e a página
// atualiza ao abrir, via JSONP do feed do Blogger (sem esperar o robô).

const ARQ_PARCEIROS = path.join(RAIZ, "data", "fontes-parceiras.json");
const PARCEIROS_PADRAO = [
  { nome: "O Que a Notícia Não Disse", url: "https://oqueanoticianaodisse.blogspot.com",
    rotulo: "Opinião", quantidade: 6 }
];

function urlFeedBlogger(base, qtd, callback) {
  const raiz = String(base).replace(/\/+$/, "");
  return `${raiz}/feeds/posts/default?alt=${callback ? "json-in-script&callback=" + callback : "json"}&max-results=${qtd}`;
}

/** Miniatura do Blogger vem em 72px (s72-c): pede versão 640x400. */
function ampliarImagem(url) {
  return String(url || "")
    .replace(/\/s\d+(-c)?\//, "/w640-h400-c/")
    .replace(/=s\d+(-c)?$/, "=w640-h400-c");
}

function postsDoFeedBlogger(json, qtd) {
  const entradas = (json && json.feed && json.feed.entry) || [];
  return entradas.slice(0, qtd).map(e => {
    const link = ((e.link || []).find(l => l.rel === "alternate") || {}).href || "";
    const conteudo = (e.content && e.content.$t) || (e.summary && e.summary.$t) || "";
    const imgConteudo = (conteudo.match(/<img[^>]+src="([^"]+)"/i) || [])[1] || "";
    const thumb = (e["media$thumbnail"] && e["media$thumbnail"].url) || "";
    return {
      titulo: B.limparHtml((e.title && e.title.$t) || ""),
      link,
      imagem: thumb ? ampliarImagem(thumb) : imgConteudo,
      data: (e.published && e.published.$t) || "",
      resumo: B.cortar(B.limparHtml(conteudo).replace(/^Publicado em \d{1,2}\/\d{1,2}\/\d{4}( às \d{1,2}:\d{2})?\s*/i, ""), 150)
    };
  }).filter(p => p.titulo && /^https?:/.test(p.link));
}

async function buscarParceiros() {
  const lista = B.lerJson(ARQ_PARCEIROS, PARCEIROS_PADRAO);
  const out = [];
  for (const p of lista) {
    const qtd = p.quantidade || 6;
    let posts = [];
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(urlFeedBlogger(p.url, qtd), { signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) posts = postsDoFeedBlogger(await r.json(), qtd);
      console.log(`Parceiro ${p.nome}: ${posts.length} posts`);
    } catch (e) {
      console.warn(`Parceiro ${p.nome}: feed indisponível (${e.message}); a página tenta de novo ao abrir`);
    }
    out.push({ ...p, quantidade: qtd, posts });
  }
  return out;
}

function cardParceiroHtml(post, cor) {
  const reserva = `assets/capa-${cor}.svg`;
  const d = dataCurta(post.data);
  return `
        <article class="p-card p-parceiro__card">
          <a class="p-card__capa" ${alvo(post)} tabindex="-1" aria-hidden="true"><img src="${post.imagem ? esc(post.imagem) : reserva}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${reserva}'"></a>
          ${d ? `<span class="p-meta"><time datetime="${esc(post.data)}">${d}</time></span>` : ""}
          <h3><a ${alvo(post)}>${esc(post.titulo)}</a></h3>
          ${post.resumo ? `<p class="p-parceiro__resumo">${esc(post.resumo)}</p>` : ""}
        </article>`;
}

function secaoParceiroHtml(p, i) {
  const id = `parceiro-${i}`;
  return `
  <section class="p-parceiro" id="${id}" data-feed="${esc(urlFeedBlogger(p.url, p.quantidade, "__CB__"))}" data-lote="${p.quantidade}"${p.posts.length ? "" : " hidden"}>
    <div class="p-parceiro__cabecalho">
      <div>
        ${p.rotulo ? `<span class="p-parceiro__rotulo">${esc(p.rotulo)}</span>` : ""}
        <h2>${esc(p.nome)}</h2>
      </div>
      <div class="p-parceiro__controles">
        <button type="button" class="p-parceiro__seta" data-dir="-1" aria-label="Posts anteriores" disabled>‹</button>
        <button type="button" class="p-parceiro__seta" data-dir="1" aria-label="Mais posts">›</button>
        <a class="p-parceiro__link" href="${esc(p.url)}" target="_blank" rel="noopener">Ver o blog →</a>
      </div>
    </div>
    <div class="p-parceiro__trilho" tabindex="0" role="region" aria-label="Posts do blog ${esc(p.nome)}">
${p.posts.map(post => cardParceiroHtml(post, "neutro")).join("\n")}
    </div>
  </section>`;
}

/**
 * Carrossel arrastável com carregamento contínuo (ES5, sem dependências).
 * 1ª busca: atualiza os posts gravados pelo robô (start-index=1).
 * Ao chegar perto do fim do trilho: busca o próximo lote (start-index=carregados+1).
 * Para quando o blog devolve menos posts que o lote. Falhou? Mantém o que já está na tela.
 */
function scriptParceirosHtml() {
  return `<script>
(function () {
  function ampliar(u) { return String(u || "").replace(/\\/s\\d+(-c)?\\//, "/w640-h400-c/").replace(/=s\\d+(-c)?$/, "=w640-h400-c"); }
  function texto(h) { var d = document.createElement("div"); d.innerHTML = h || ""; return (d.textContent || "").replace(/\\s+/g, " ").replace(/^\\s+|\\s+$/g, ""); }
  function limparResumo(t) { return t.replace(/^Publicado em \\d{1,2}\\/\\d{1,2}\\/\\d{4}( às \\d{1,2}:\\d{2})?\\s*/i, ""); }
  function cortar(t, n) { if (t.length <= n) return t; t = t.slice(0, n); var i = t.lastIndexOf(" "); return (i > n * 0.6 ? t.slice(0, i) : t) + "\\u2026"; }
  function dataCurta(iso) {
    var d = new Date(iso); if (isNaN(d)) return "";
    var hoje = new Date(); function dd(n) { return (n < 10 ? "0" : "") + n; }
    if (d.toDateString() === hoje.toDateString()) return "Hoje, " + dd(d.getHours()) + ":" + dd(d.getMinutes());
    return dd(d.getDate()) + "/" + dd(d.getMonth() + 1);
  }
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt) e.textContent = txt; return e; }
  function link(href, cls) { var a = el("a", cls); a.href = href; a.target = "_blank"; a.rel = "noopener"; return a; }
  function hrefDe(e) { var l = e.link || [], h = ""; for (var j = 0; j < l.length; j++) if (l[j].rel === "alternate") h = l[j].href; return h; }
  function cardDe(e, href) {
    var conteudo = (e.content && e.content.$t) || (e.summary && e.summary.$t) || "";
    var m = /<img[^>]+src="([^"]+)"/i.exec(conteudo);
    var thumb = e["media$thumbnail"] && e["media$thumbnail"].url;
    var art = el("article", "p-card p-parceiro__card");
    var capa = link(href, "p-card__capa"); capa.tabIndex = -1; capa.setAttribute("aria-hidden", "true");
    var img = document.createElement("img"); img.alt = ""; img.loading = "lazy";
    img.onerror = function () { this.onerror = null; this.src = "assets/capa-neutro.svg"; };
    img.src = thumb ? ampliar(thumb) : (m ? m[1] : "assets/capa-neutro.svg");
    capa.appendChild(img); art.appendChild(capa);
    var data = dataCurta(e.published && e.published.$t);
    if (data) { var meta = el("span", "p-meta"); meta.appendChild(el("time", "", data)); art.appendChild(meta); }
    var h3 = el("h3"); var ta = link(href); ta.textContent = texto(e.title && e.title.$t); h3.appendChild(ta); art.appendChild(h3);
    var res = cortar(limparResumo(texto(conteudo)), 150); if (res) art.appendChild(el("p", "p-parceiro__resumo", res));
    return art;
  }
  var seq = 0;
  var secoes = document.querySelectorAll(".p-parceiro[data-feed]");
  for (var i = 0; i < secoes.length; i++) (function (sec) {
    var trilho = sec.querySelector(".p-parceiro__trilho");
    var setas = sec.querySelectorAll(".p-parceiro__seta");
    var lote = +sec.getAttribute("data-lote") || 6;
    var base = sec.getAttribute("data-feed");
    var carregados = 0, fim = false, carregando = false, primeira = true, vistos = {}, aviso = null;

    function noFim() { return trilho.scrollLeft + trilho.clientWidth >= trilho.scrollWidth - 8; }
    function atualizarSetas() {
      setas[0].disabled = trilho.scrollLeft <= 8;
      setas[1].disabled = fim && noFim();
    }
    function mostrarCarregando(sim) {
      if (sim && !aviso) { aviso = el("div", "p-parceiro__carregando", "Carregando mais posts\\u2026"); trilho.appendChild(aviso); }
      if (!sim && aviso) { if (aviso.parentNode) aviso.parentNode.removeChild(aviso); aviso = null; }
    }
    function buscar(inicio, pronto) {
      var nome = "__parceiro_" + (++seq) + "_" + new Date().getTime();
      var s = document.createElement("script");
      var encerrar = function () { try { delete window[nome]; } catch (x) { window[nome] = undefined; } if (s.parentNode) s.parentNode.removeChild(s); };
      window[nome] = function (json) { encerrar(); pronto(json); };
      s.onerror = function () { encerrar(); carregando = false; mostrarCarregando(false); };
      s.src = base.replace("__CB__", nome) + "&start-index=" + inicio;
      document.body.appendChild(s);
    }
    function carregarMais() {
      if (fim || carregando) return;
      carregando = true;
      if (!primeira) mostrarCarregando(true);
      buscar(primeira ? 1 : carregados + 1, function (json) {
        var ent = (json && json.feed && json.feed.entry) || [];
        mostrarCarregando(false);
        if (primeira && ent.length) { trilho.innerHTML = ""; vistos = {}; carregados = 0; }
        primeira = false;
        for (var k = 0; k < ent.length; k++) {
          var href = hrefDe(ent[k]);
          if (!href || vistos[href]) continue;
          vistos[href] = true;
          trilho.appendChild(cardDe(ent[k], href));
        }
        carregados += ent.length;
        if (ent.length < lote) fim = true;
        if (trilho.children.length) sec.hidden = false;
        carregando = false;
        atualizarSetas();
        verificar();
      });
    }
    function verificar() {
      if (trilho.scrollLeft + trilho.clientWidth * 1.8 >= trilho.scrollWidth) carregarMais();
    }
    var agendado = false;
    trilho.addEventListener("scroll", function () {
      if (agendado) return; agendado = true;
      setTimeout(function () { agendado = false; atualizarSetas(); verificar(); }, 120);
    });
    for (var b = 0; b < setas.length; b++) setas[b].addEventListener("click", function () {
      var passo = trilho.clientWidth * 0.9 * (+this.getAttribute("data-dir"));
      if (trilho.scrollBy) trilho.scrollBy({ left: passo, behavior: "smooth" }); else trilho.scrollLeft += passo;
    });
    carregarMais();
  })(secoes[i]);
})();
</script>`;
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

function htmlCapa(noticias, boletins, parceiros) {
  const { hero, ultimas, secundarias, blocos, mais } = montarCapa(noticias, boletins);
  const secoesParceiros = (parceiros || []).map(secaoParceiroHtml).join("\n");
  const ultima = boletins[0];
  const hoje = new Date().toLocaleDateString("pt-BR",
    { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "America/Sao_Paulo" });

  const conteudo = hero ? `
  <div class="p-topo-grade">
${heroHtml(hero)}
${ultimasHtml(ultimas)}
  </div>
${secoesParceiros}

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
<link rel="stylesheet" href="assets/estilo.css?v=${B.versaoCss()}">
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
${secoesParceiros ? scriptParceirosHtml() : ""}
</body>
</html>
`;
}

/** Ponto de entrada. novas: notícias da edição recém-gerada (opcional). */
async function gerarCapa(novas) {
  const boletins = B.lerJson(ARQ_BOLETINS, []);
  const parceiros = await buscarParceiros();
  let noticias = B.lerJson(ARQ_NOTICIAS, []);
  let origem = "data/noticias.json";
  if (noticias.length < 12) {
    noticias = mesclar(noticias, backfill(boletins));
    origem = "backfill das páginas publicadas";
  }
  noticias = mesclar(novas || [], noticias);
  B.salvarJson(ARQ_NOTICIAS, noticias);
  fs.writeFileSync(path.join(RAIZ, "index.html"), htmlCapa(filtrarParaCapa(noticias), boletins, parceiros), "utf8");
  console.log(`Capa gerada: ${noticias.length} notícias (${origem}), ${boletins.length} edições`);
}

module.exports = { gerarCapa, lerEdicaoHtml, montarCapa, postsDoFeedBlogger, ampliarImagem };

if (require.main === module) gerarCapa().catch(e => { console.error(e); process.exit(1); });
