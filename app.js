import { parse } from "https://cdn.jsdelivr.net/npm/smol-toml@1.3.1/+esm";

const DEFAULTS = { owner: "5zsdw5jd44-ui", repo: "ight-monitor" };
const WORKFLOW = "monitor.yml";
const FILE = "buscas.toml";
const BRANCH = "main";
const DEMO = new URLSearchParams(location.search).has("demo");
const DEMO_NOTICE = "Modo demonstração: nada é salvo no GitHub.";
const CABINS = [
  { key: "economica", label: "Econômica", stops: 0, hours: "" },
  { key: "premium", label: "Premium Economy", stops: 0, hours: "" },
  { key: "executiva", label: "Executiva", stops: 1, hours: 12 },
  { key: "primeira", label: "Primeira classe", stops: 1, hours: 12 },
];
// Free SerpApi plan: (250 - 10 reserve) / 60 runs a month ≈ 4 searches per run.
const SEARCHES_PER_RUN = 4;
const RUNS_PER_DAY = 2;
const VIEW_TITLES = { searches: "Buscas", status: "Situação", settings: "Ajustes" };

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  view: "searches",
  header: "",
  searches: [],
  sha: null,
  loaded: false,
  editing: null,
  pollTimer: null,
};

class AppError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/* ---------- storage (per device) ---------- */

function readStore(key, fallback = "") {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStore(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode: the key lasts only for this visit */
  }
}

const memory = {};
function config() {
  return {
    token: memory.token ?? readStore("gh_token"),
    owner: readStore("gh_owner", DEFAULTS.owner) || DEFAULTS.owner,
    repo: readStore("gh_repo", DEFAULTS.repo) || DEFAULTS.repo,
  };
}

/* ---------- GitHub API ---------- */

function describeError(status, data) {
  const message = data && data.message ? String(data.message) : "";
  if (status === 401) return "A chave do GitHub é inválida ou expirou. Crie outra em Ajustes.";
  if (status === 403 && /rate limit/i.test(message)) return "Limite de uso do GitHub atingido. Tente de novo em alguns minutos.";
  if (status === 403) return "A chave não tem permissão para isso. Confira as permissões em Ajustes.";
  if (status === 404) return "Repositório não encontrado, ou a chave não tem acesso a ele. Confira em Ajustes.";
  if (status === 409) return "O arquivo de buscas mudou em outro lugar. Toque em atualizar e tente de novo.";
  if (status === 422) return message || "O GitHub recusou o pedido.";
  return `Erro ${status} do GitHub${message ? `: ${message}` : ""}.`;
}

async function gh(path, { method = "GET", body } = {}) {
  if (DEMO) return demoApi(path, method, body);
  const { token, owner, repo } = config();
  if (!token) throw new AppError("Configure a chave de acesso em Ajustes.", "setup");
  let response;
  try {
    response = await fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, {
      method,
      cache: "no-store",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new AppError("Sem conexão com o GitHub. Confira a internet.", "network");
  }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new AppError(describeError(response.status, data), response.status);
  return data;
}

function decodeBase64(text) {
  const binary = atob(text.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

function encodeBase64(text) {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/* ---------- dates ---------- */

function todaySaoPaulo() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
}

function isDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "") && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function addDays(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(start, end) {
  const out = [];
  for (let day = start; day <= end && out.length < 400; day = addDays(day, 1)) out.push(day);
  return out;
}

function formatDate(value, withYear = true) {
  if (!isDate(value)) return "?";
  const [year, month, day] = value.split("-");
  return withYear ? `${day}/${month}/${year}` : `${day}/${month}`;
}

function formatBRL(value) {
  return `R$ ${Number(value).toLocaleString("pt-BR", { maximumFractionDigits: 0 })}`;
}

function formatWhen(iso) {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

/* ---------- buscas.toml <-> model ---------- */

function dateText(value) {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function rangeFrom(value) {
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return { tipo: "faixa", de: dateText(value.de), ate: dateText(value.ate) };
  }
  return { tipo: "fixa", de: dateText(value), ate: "" };
}

function fromToml(doc) {
  return (Array.isArray(doc.busca) ? doc.busca : []).map((raw, index) => {
    let volta;
    if (raw.dias_de_viagem != null) {
      const days = raw.dias_de_viagem;
      const low = typeof days === "object" ? Number(days.min) : Number(days);
      const high = typeof days === "object" ? Number(days.max) : Number(days);
      volta = { tipo: "dias", de: "", ate: "", min: low, max: high };
    } else {
      volta = { ...rangeFrom(raw.volta), min: "", max: "" };
    }
    const cabins = {};
    for (const cabin of CABINS) {
      const options = raw[cabin.key];
      cabins[cabin.key] = options
        ? {
            on: true,
            max_brl: options.max_brl ?? "",
            max_conexoes: options.max_conexoes ?? cabin.stops,
            horas: options.max_conexao_horas ?? cabin.hours,
          }
        : { on: false, max_brl: "", max_conexoes: cabin.stops, horas: cabin.hours };
    }
    return {
      nome: String(raw.nome ?? `Busca ${index + 1}`),
      origem: String(raw.origem ?? "").toUpperCase(),
      destino: String(raw.destino ?? "").toUpperCase(),
      adultos: Number(raw.adultos ?? 1),
      ativa: raw.ativa !== false,
      ida: rangeFrom(raw.ida),
      volta,
      cabins,
    };
  });
}

function headerOf(text) {
  const index = text.search(/^\[\[busca\]\]/m);
  return (index >= 0 ? text.slice(0, index) : text).trimEnd();
}

function quote(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function rangeToml(range) {
  return range.tipo === "faixa"
    ? `{ de = ${quote(range.de)}, ate = ${quote(range.ate)} }`
    : quote(range.de);
}

function toToml(searches, header) {
  const lines = header ? [header, ""] : [];
  for (const search of searches) {
    lines.push("[[busca]]");
    lines.push(`nome = ${quote(search.nome)}`);
    lines.push(`origem = ${quote(search.origem)}`);
    lines.push(`destino = ${quote(search.destino)}`);
    lines.push(`ida = ${rangeToml(search.ida)}`);
    if (search.volta.tipo === "dias") {
      const { min, max } = search.volta;
      lines.push(
        Number(min) === Number(max)
          ? `dias_de_viagem = ${Number(min)}`
          : `dias_de_viagem = { min = ${Number(min)}, max = ${Number(max)} }`,
      );
    } else {
      lines.push(`volta = ${rangeToml(search.volta)}`);
    }
    lines.push(`adultos = ${Number(search.adultos) || 1}`);
    if (!search.ativa) lines.push("ativa = false");
    for (const cabin of CABINS) {
      const options = search.cabins[cabin.key];
      if (!options.on) continue;
      lines.push("", `[busca.${cabin.key}]`);
      lines.push(`max_brl = ${Math.round(Number(options.max_brl))}`);
      lines.push(`max_conexoes = ${Math.round(Number(options.max_conexoes))}`);
      if (options.horas !== "" && options.horas != null) {
        lines.push(`max_conexao_horas = ${Number(options.horas)}`);
      }
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/* ---------- rules shared with the monitor ---------- */

function trips(search, today = todaySaoPaulo()) {
  const { ida, volta } = search;
  if (!isDate(ida.de)) return [];
  const outbound = ida.tipo === "faixa" ? (isDate(ida.ate) ? daysBetween(ida.de, ida.ate) : []) : [ida.de];
  const pairs = [];
  if (volta.tipo === "dias") {
    const low = Number(volta.min);
    const high = Number(volta.max);
    if (!(low >= 1 && high >= low)) return [];
    for (const day of outbound) for (let length = low; length <= high; length += 1) pairs.push([day, addDays(day, length)]);
  } else {
    if (!isDate(volta.de)) return [];
    const back = volta.tipo === "faixa" ? (isDate(volta.ate) ? daysBetween(volta.de, volta.ate) : []) : [volta.de];
    for (const day of outbound) for (const ret of back) if (ret > day) pairs.push([day, ret]);
  }
  return pairs.filter(([day]) => day >= today);
}

function activeCabins(search) {
  return CABINS.filter((cabin) => search.cabins[cabin.key].on);
}

function cost(search) {
  return trips(search).length * activeCabins(search).length;
}

function revisitText(totalCost) {
  if (totalCost <= 0) return "";
  if (totalCost <= SEARCHES_PER_RUN) return "toda rodada (2 vezes ao dia)";
  const days = Math.ceil(totalCost / SEARCHES_PER_RUN) / RUNS_PER_DAY;
  return `a cada ~${days.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} dia(s)`;
}

function validate(search, others) {
  if (!search.nome.trim()) return ["nome", "Dê um nome à busca."];
  if (others.some((other) => other.nome.trim().toLowerCase() === search.nome.trim().toLowerCase())) {
    return ["nome", "Já existe uma busca com esse nome."];
  }
  if (!/^[A-Z]{3}$/.test(search.origem)) return ["origem", "Origem: use o código de 3 letras do aeroporto (ex.: GRU)."];
  if (!/^[A-Z]{3}$/.test(search.destino)) return ["destino", "Destino: use o código de 3 letras do aeroporto (ex.: MAD)."];
  if (search.origem === search.destino) return ["destino", "Origem e destino são iguais."];
  if (!isDate(search.ida.de)) return ["ida_de", "Escolha a data de ida."];
  if (search.ida.tipo === "faixa" && (!isDate(search.ida.ate) || search.ida.ate < search.ida.de)) {
    return ["ida_ate", "A data final da ida precisa ser igual ou depois da inicial."];
  }
  if (search.volta.tipo === "dias") {
    const low = Number(search.volta.min);
    const high = Number(search.volta.max);
    if (!Number.isInteger(low) || low < 1) return ["dias_min", "Informe o mínimo de dias da viagem."];
    if (!Number.isInteger(high) || high < low) return ["dias_max", "O máximo de dias precisa ser igual ou maior que o mínimo."];
  } else {
    if (!isDate(search.volta.de)) return ["volta_de", "Escolha a data de volta."];
    if (search.volta.tipo === "faixa" && (!isDate(search.volta.ate) || search.volta.ate < search.volta.de)) {
      return ["volta_ate", "A data final da volta precisa ser igual ou depois da inicial."];
    }
  }
  const cabins = activeCabins(search);
  if (!cabins.length) return ["cabins", "Ligue pelo menos uma classe."];
  for (const cabin of cabins) {
    const options = search.cabins[cabin.key];
    if (!(Number(options.max_brl) > 0)) return [`${cabin.key}_max`, `${cabin.label}: informe o preço máximo.`];
    if (!Number.isInteger(Number(options.max_conexoes)) || Number(options.max_conexoes) < 0) {
      return [`${cabin.key}_stops`, `${cabin.label}: conexões precisa ser 0 ou mais.`];
    }
    if (options.horas !== "" && !(Number(options.horas) > 0)) {
      return [`${cabin.key}_hours`, `${cabin.label}: horas de conexão precisa ser positivo (ou vazio).`];
    }
  }
  if (!(Number(search.adultos) >= 1 && Number(search.adultos) <= 9)) return ["adultos", "Adultos: de 1 a 9."];
  if (!trips(search).length) {
    return ["ida_de", "Nenhuma combinação válida: as datas já passaram ou a volta é antes da ida."];
  }
  return null;
}

/* ---------- UI helpers ---------- */

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

let toastTimer;
function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (element.hidden = true), 3500);
}

function banner(message, kind = "warn") {
  const element = $("#banner");
  element.hidden = !message;
  element.textContent = message || "";
  element.className = `banner ${kind === "bad" ? "bad" : ""}`;
}

function busy(on) {
  $("#refresh").classList.toggle("spinning", on);
}

function datesSummary(search) {
  const { ida, volta } = search;
  const out = ida.tipo === "faixa" ? `Ida entre ${formatDate(ida.de, false)} e ${formatDate(ida.ate)}` : `Ida ${formatDate(ida.de)}`;
  let back;
  if (volta.tipo === "dias") {
    back = Number(volta.min) === Number(volta.max) ? `viagem de ${volta.min} dias` : `viagem de ${volta.min} a ${volta.max} dias`;
  } else if (volta.tipo === "faixa") {
    back = `volta entre ${formatDate(volta.de, false)} e ${formatDate(volta.ate)}`;
  } else {
    back = `volta ${formatDate(volta.de)}`;
  }
  return `${out} · ${back}`;
}

/* ---------- searches view ---------- */

function renderSearches() {
  const container = $("#searches");
  if (!state.loaded) {
    container.innerHTML = "";
    return;
  }
  if (!state.searches.length) {
    container.innerHTML = `<div class="card empty">Nenhuma busca ainda.<br>Toque em <b>+ Nova busca</b>.</div>`;
  } else {
    container.innerHTML = state.searches
      .map((search, index) => {
        const searchCost = cost(search);
        const finished = searchCost === 0;
        const tag = finished
          ? `<span class="tag done">Encerrada</span>`
          : search.ativa
            ? `<span class="tag on">Ativa</span>`
            : `<span class="tag off">Pausada</span>`;
        const chips = activeCabins(search)
          .map((cabin) => `<span class="chip">${cabin.label} até ${formatBRL(search.cabins[cabin.key].max_brl)}</span>`)
          .join("");
        const combos = trips(search).length;
        const costLine = finished
          ? "Datas já passaram; não gasta buscas."
          : `${combos} combinação(ões) de datas · ${searchCost} busca(s) por volta completa`;
        return `
          <button class="card search-card" type="button" data-index="${index}">
            <div class="search-head"><span class="search-name">${escapeHtml(search.nome)}</span>${tag}</div>
            <div class="route">${escapeHtml(search.origem)}<span class="arrow">→</span>${escapeHtml(search.destino)}</div>
            <div class="dates">${escapeHtml(datesSummary(search))}${Number(search.adultos) > 1 ? ` · ${search.adultos} adultos` : ""}</div>
            <div class="chips">${chips}</div>
            <div class="cost">${costLine}</div>
          </button>`;
      })
      .join("");
  }
  const total = state.searches.filter((search) => search.ativa).reduce((sum, search) => sum + cost(search), 0);
  $("#budget-note").textContent = total
    ? `Todas as buscas ativas somam ${total} busca(s) por volta completa. Com o plano gratuito, cada data é revisitada ${revisitText(total)}.`
    : "";
}

async function loadSearches() {
  const data = await gh(`/contents/${FILE}?ref=${BRANCH}`);
  const text = decodeBase64(data.content);
  let doc;
  try {
    doc = parse(text);
  } catch (error) {
    throw new AppError(`O arquivo ${FILE} tem um erro de digitação: ${error.message}`, "toml");
  }
  state.sha = data.sha;
  state.header = headerOf(text);
  state.searches = fromToml(doc);
  state.loaded = true;
  renderSearches();
}

async function commitSearches(searches, message) {
  const text = toToml(searches, state.header);
  parse(text); // never write a file the monitor cannot read
  const result = await gh(`/contents/${FILE}`, {
    method: "PUT",
    body: { message, content: encodeBase64(text), sha: state.sha, branch: BRANCH },
  });
  state.sha = result.content.sha;
  state.searches = searches;
  renderSearches();
}

/* ---------- editor ---------- */

function renderCabinFields() {
  $("#cabins").innerHTML = CABINS.map(
    (cabin) => `
      <div class="cabin" data-cabin="${cabin.key}" data-on="false">
        <label class="cabin-head">${cabin.label}
          <input type="checkbox" name="${cabin.key}_on" aria-label="Buscar ${cabin.label}">
        </label>
        <div class="cabin-fields">
          <label>Preço máx. (R$)
            <input type="number" name="${cabin.key}_max" inputmode="numeric" min="1" step="1" placeholder="10000">
          </label>
          <label>Conexões
            <input type="number" name="${cabin.key}_stops" inputmode="numeric" min="0" step="1">
          </label>
          <label>Horas conex.
            <input type="number" name="${cabin.key}_hours" inputmode="decimal" min="0" step="0.5" placeholder="livre">
          </label>
        </div>
      </div>`,
  ).join("");
}

function setSegment(group, value) {
  const form = $("#search-form");
  form.dataset[group] = value;
  $$(`.segmented[data-group="${group}"] button`, form).forEach((button) =>
    button.setAttribute("aria-pressed", String(button.dataset.value === value)),
  );
  $$("[data-show]", form).forEach((element) => {
    const [name, values] = element.dataset.show.split(":");
    if (name === group) element.hidden = !values.split(",").includes(value);
  });
  if (group === "ida") $("[data-ida-label]").textContent = value === "faixa" ? "De" : "Data";
  if (group === "volta") $("[data-volta-label]").textContent = value === "faixa" ? "De" : "Data";
}

function blankSearch() {
  const cabins = {};
  for (const cabin of CABINS) {
    cabins[cabin.key] = { on: false, max_brl: "", max_conexoes: cabin.stops, horas: cabin.hours };
  }
  cabins.economica.on = true;
  return {
    nome: "",
    origem: "GRU",
    destino: "",
    adultos: 1,
    ativa: true,
    ida: { tipo: "fixa", de: "", ate: "" },
    volta: { tipo: "fixa", de: "", ate: "", min: "", max: "" },
    cabins,
  };
}

function fillForm(search) {
  const form = $("#search-form");
  form.elements.nome.value = search.nome;
  form.elements.origem.value = search.origem;
  form.elements.destino.value = search.destino;
  form.elements.adultos.value = search.adultos;
  form.elements.ativa.checked = search.ativa;
  form.elements.ida_de.value = search.ida.de;
  form.elements.ida_ate.value = search.ida.ate;
  form.elements.volta_de.value = search.volta.de;
  form.elements.volta_ate.value = search.volta.ate;
  form.elements.dias_min.value = search.volta.min;
  form.elements.dias_max.value = search.volta.max;
  setSegment("ida", search.ida.tipo);
  setSegment("volta", search.volta.tipo);
  for (const cabin of CABINS) {
    const options = search.cabins[cabin.key];
    form.elements[`${cabin.key}_on`].checked = options.on;
    form.elements[`${cabin.key}_max`].value = options.max_brl;
    form.elements[`${cabin.key}_stops`].value = options.max_conexoes;
    form.elements[`${cabin.key}_hours`].value = options.horas;
    $(`.cabin[data-cabin="${cabin.key}"]`).dataset.on = String(options.on);
  }
}

function readForm() {
  const form = $("#search-form");
  const value = (name) => form.elements[name].value.trim();
  const cabins = {};
  for (const cabin of CABINS) {
    cabins[cabin.key] = {
      on: form.elements[`${cabin.key}_on`].checked,
      max_brl: value(`${cabin.key}_max`),
      max_conexoes: value(`${cabin.key}_stops`) === "" ? cabin.stops : value(`${cabin.key}_stops`),
      horas: value(`${cabin.key}_hours`),
    };
  }
  return {
    nome: value("nome"),
    origem: value("origem").toUpperCase(),
    destino: value("destino").toUpperCase(),
    adultos: value("adultos") || 1,
    ativa: form.elements.ativa.checked,
    ida: { tipo: form.dataset.ida, de: value("ida_de"), ate: form.dataset.ida === "faixa" ? value("ida_ate") : "" },
    volta: {
      tipo: form.dataset.volta,
      de: form.dataset.volta === "dias" ? "" : value("volta_de"),
      ate: form.dataset.volta === "faixa" ? value("volta_ate") : "",
      min: value("dias_min"),
      max: value("dias_max"),
    },
    cabins,
  };
}

function updateEstimate() {
  const search = readForm();
  const combos = trips(search).length;
  const cabins = activeCabins(search).length;
  const element = $("#estimate");
  if (!combos || !cabins) {
    element.textContent = "";
    return;
  }
  const searchCost = combos * cabins;
  element.textContent =
    `${combos} combinação(ões) de datas × ${cabins} classe(s) = ${searchCost} busca(s) por volta completa. ` +
    `Sozinha, cada data seria revisitada ${revisitText(searchCost)}.` +
    (combos > 30 ? " É bastante para o plano gratuito; considere estreitar as datas." : "");
}

function openEditor(index) {
  state.editing = index;
  const search = index == null ? blankSearch() : structuredClone(state.searches[index]);
  $("#editor-title").textContent = index == null ? "Nova busca" : "Editar busca";
  $("#delete").hidden = index == null;
  $("#form-error").textContent = "";
  $$("#search-form [aria-invalid]").forEach((input) => input.removeAttribute("aria-invalid"));
  fillForm(search);
  updateEstimate();
  $("#editor").showModal();
  $(".sheet-body").scrollTop = 0;
}

function showFormError([field, message]) {
  const form = $("#search-form");
  $("#form-error").textContent = message;
  $$("[aria-invalid]", form).forEach((input) => input.removeAttribute("aria-invalid"));
  const input = form.elements[field];
  if (input && input.focus) {
    input.setAttribute("aria-invalid", "true");
    input.focus();
  }
}

async function saveEditor() {
  const search = readForm();
  const others = state.searches.filter((_, index) => index !== state.editing);
  const problem = validate(search, others);
  if (problem) {
    showFormError(problem);
    return;
  }
  const next = [...state.searches];
  if (state.editing == null) next.push(search);
  else next[state.editing] = search;
  const verb = state.editing == null ? "nova" : "edita";
  await withSaving(() => commitSearches(next, `App: ${verb} busca "${search.nome}"`));
}

async function deleteSearch() {
  const search = state.searches[state.editing];
  if (!confirm(`Excluir a busca "${search.nome}"?`)) return;
  const next = state.searches.filter((_, index) => index !== state.editing);
  await withSaving(() => commitSearches(next, `App: exclui busca "${search.nome}"`));
}

async function withSaving(action) {
  const button = $("#save");
  button.disabled = true;
  button.textContent = "Salvando…";
  try {
    await action();
    $("#editor").close();
    toast("Salvo. Vale a partir da próxima rodada.");
  } catch (error) {
    $("#form-error").textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "Salvar";
  }
}

/* ---------- status view ---------- */

async function runDetails(run) {
  try {
    const { jobs } = await gh(`/actions/runs/${run.id}/jobs`);
    if (!jobs || !jobs.length) return [];
    const annotations = await gh(`/check-runs/${jobs[0].id}/annotations`);
    return (annotations || []).filter((note) => note.annotation_level === "notice");
  } catch {
    return null;
  }
}

function runBadge(run) {
  if (run.status !== "completed") return `<span class="badge wait">Rodando…</span>`;
  if (run.conclusion === "success") return `<span class="badge ok">OK</span>`;
  if (run.conclusion === "cancelled") return `<span class="badge wait">Cancelada</span>`;
  return `<span class="badge bad">Falhou</span>`;
}

async function loadStatus() {
  const data = await gh(`/actions/workflows/${WORKFLOW}/runs?per_page=6&branch=${BRANCH}`);
  const runs = data.workflow_runs || [];
  const details = await Promise.all(runs.map((run) => (run.status === "completed" ? runDetails(run) : [])));

  let balanceShown = false;
  $("#balance").textContent = "—";
  $("#balance-note").textContent = "Aparece depois da primeira rodada desta versão do monitor.";
  runs.forEach((run, index) => {
    const notes = details[index] || [];
    const balance = notes.find((note) => note.title === "Saldo SerpApi");
    if (balance && !balanceShown) {
      balanceShown = true;
      $("#balance").textContent = balance.message;
      $("#balance-note").textContent = `No início da rodada de ${formatWhen(run.run_started_at || run.created_at)}. O plano gratuito tem 250 por mês.`;
    }
  });

  $("#runs").innerHTML = runs.length
    ? runs
        .map((run, index) => {
          const notes = details[index];
          const lines = [];
          if (notes === null) {
            lines.push(`<div class="run-line">Detalhes indisponíveis (confira a permissão “Checks” da chave).</div>`);
          } else {
            for (const note of notes) {
              if (note.title === "Rodada") lines.push(`<div class="run-line">${escapeHtml(note.message)}</div>`);
              if (note.title === "Oferta") lines.push(`<div class="run-offer">✈️ ${escapeHtml(note.message)}</div>`);
            }
            if (run.status === "completed" && run.conclusion === "success" && !notes.some((note) => note.title === "Oferta")) {
              lines.push(`<div class="run-line">Nenhuma oferta dentro dos limites.</div>`);
            }
          }
          const kind = run.event === "schedule" ? "Automática" : "Manual";
          return `
            <div class="card run">
              <div class="run-head">
                <div><div class="run-when">${formatWhen(run.run_started_at || run.created_at)}</div><div class="run-kind">${kind}</div></div>
                ${runBadge(run)}
              </div>
              ${lines.join("")}
              <a href="${escapeHtml(run.html_url)}" target="_blank" rel="noopener">Ver no GitHub</a>
            </div>`;
        })
        .join("")
    : `<div class="card empty">Nenhuma rodada ainda.</div>`;

  clearTimeout(state.pollTimer);
  if (runs.some((run) => run.status !== "completed") && state.view === "status") {
    state.pollTimer = setTimeout(() => refresh(), 15000);
  }
}

async function dispatch(dryRun) {
  if (!dryRun && !confirm("Buscar agora e enviar e-mail/WhatsApp se achar oferta? Gasta até 8 buscas da SerpApi.")) return;
  const buttons = [$("#run-real"), $("#run-test")];
  buttons.forEach((button) => (button.disabled = true));
  try {
    await gh(`/actions/workflows/${WORKFLOW}/dispatches`, {
      method: "POST",
      body: { ref: BRANCH, inputs: { dry_run: dryRun ? "true" : "false" } },
    });
    toast(dryRun ? "Teste iniciado. Leva uns 2 minutos." : "Busca iniciada. Leva uns 2 minutos.");
    setTimeout(() => refresh(), 5000);
  } catch (error) {
    banner(error.message, "bad");
  } finally {
    setTimeout(() => buttons.forEach((button) => (button.disabled = false)), 5000);
  }
}

/* ---------- settings ---------- */

function fillSettings() {
  const { token, owner, repo } = config();
  $("#token").value = token;
  $("#owner").value = owner;
  $("#repo").value = repo;
}

async function saveSettings(event) {
  event.preventDefault();
  const token = $("#token").value.trim();
  memory.token = token;
  writeStore("gh_token", token || null);
  writeStore("gh_owner", $("#owner").value.trim() || DEFAULTS.owner);
  writeStore("gh_repo", $("#repo").value.trim() || DEFAULTS.repo);
  const result = $("#settings-result");
  result.textContent = "Testando…";
  try {
    const repo = await gh("");
    await loadSearches();
    result.textContent = `Conectado a ${repo.full_name} ✓ (${state.searches.length} busca(s)).`;
    banner("");
  } catch (error) {
    result.textContent = error.message;
  }
}

function forgetToken() {
  if (!confirm("Apagar a chave deste aparelho?")) return;
  memory.token = "";
  writeStore("gh_token", null);
  fillSettings();
  $("#settings-result").textContent = "Chave apagada deste aparelho.";
}

/* ---------- navigation ---------- */

function showView(view) {
  state.view = view;
  for (const name of Object.keys(VIEW_TITLES)) $(`#view-${name}`).hidden = name !== view;
  $$(".tab").forEach((tab) =>
    tab.dataset.view === view ? tab.setAttribute("aria-current", "page") : tab.removeAttribute("aria-current"),
  );
  $("#title").textContent = VIEW_TITLES[view];
  $("#refresh").hidden = view === "settings";
  writeStore("last_view", view);
  if (view === "settings") fillSettings();
  else refresh();
}

async function refresh() {
  if (state.view === "settings") return;
  if (!DEMO && !config().token) {
    banner("Para começar, crie a chave de acesso do GitHub em Ajustes.");
    return;
  }
  busy(true);
  try {
    if (state.view === "searches") await loadSearches();
    else await loadStatus();
    banner(DEMO ? DEMO_NOTICE : "");
  } catch (error) {
    banner(error.message, error.code === "setup" ? "warn" : "bad");
  } finally {
    busy(false);
  }
}

function bind() {
  $$(".tab").forEach((tab) => tab.addEventListener("click", () => showView(tab.dataset.view)));
  $("#refresh").addEventListener("click", refresh);
  $("#add").addEventListener("click", () => openEditor(null));
  $("#searches").addEventListener("click", (event) => {
    const card = event.target.closest("[data-index]");
    if (card) openEditor(Number(card.dataset.index));
  });
  $$("#search-form .segmented").forEach((group) =>
    group.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-value]");
      if (!button) return;
      setSegment(group.dataset.group, button.dataset.value);
      updateEstimate();
    }),
  );
  $("#cabins").addEventListener("change", (event) => {
    if (event.target.type === "checkbox") {
      event.target.closest(".cabin").dataset.on = String(event.target.checked);
    }
  });
  // Enter in a field submits the form; save instead of closing the sheet.
  $("#search-form").addEventListener("submit", (event) => {
    if (event.submitter?.value === "cancel") return;
    event.preventDefault();
    saveEditor();
  });
  $("#search-form").addEventListener("input", updateEstimate);
  $("#search-form").addEventListener("change", updateEstimate);
  $("#save").addEventListener("click", saveEditor);
  $("#delete").addEventListener("click", deleteSearch);
  $("#run-real").addEventListener("click", () => dispatch(false));
  $("#run-test").addEventListener("click", () => dispatch(true));
  $("#settings-form").addEventListener("submit", saveSettings);
  $("#forget").addEventListener("click", forgetToken);
}

/* ---------- demo mode (?demo): fake GitHub, nothing leaves the page ---------- */

let demoFile = `# Lista de buscas do monitor de passagens.
# (cabeçalho de exemplo)

[[busca]]
nome = "Madri fim de ano"
origem = "GRU"
destino = "MAD"
ida = "2026-12-29"
volta = "2027-01-11"
adultos = 1

[busca.economica]
max_brl = 10000
max_conexoes = 0

[busca.executiva]
max_brl = 30000
max_conexoes = 1
max_conexao_horas = 12
`;
let demoSha = 1;
const demoRuns = [
  { id: 3, status: "in_progress", conclusion: null, event: "workflow_dispatch", created_at: new Date().toISOString(), html_url: "https://github.com" },
  { id: 2, status: "completed", conclusion: "success", event: "schedule", created_at: new Date(Date.now() - 4 * 3600e3).toISOString(), html_url: "https://github.com" },
  { id: 1, status: "completed", conclusion: "failure", event: "schedule", created_at: new Date(Date.now() - 16 * 3600e3).toISOString(), html_url: "https://github.com" },
];
const demoNotes = {
  2: [
    { annotation_level: "notice", title: "Saldo SerpApi", message: "229" },
    { annotation_level: "notice", title: "Rodada", message: "1 de 1 combinação(ões) pesquisada(s), 6 busca(s) usada(s)" },
    { annotation_level: "notice", title: "Oferta", message: "Madri fim de ano | Econômica | R$ 7.457 | LATAM, Iberia | 29/12/2026 a 11/01/2027" },
  ],
  1: [{ annotation_level: "warning", title: "x", message: "y" }],
};

async function demoApi(path, method, body) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (path === "") return { full_name: "demo/monitor", private: true };
  if (path.startsWith(`/contents/${FILE}`)) {
    if (method === "PUT") {
      demoFile = decodeBase64(body.content);
      demoSha += 1;
      console.info("[demo] commit:", body.message, "\n" + demoFile);
      return { content: { sha: `demo-${demoSha}` } };
    }
    return { content: encodeBase64(demoFile), sha: `demo-${demoSha}` };
  }
  if (path.startsWith(`/actions/workflows/${WORKFLOW}/runs`)) return { workflow_runs: demoRuns };
  const jobs = path.match(/^\/actions\/runs\/(\d+)\/jobs$/);
  if (jobs) return { jobs: [{ id: Number(jobs[1]) }] };
  const notes = path.match(/^\/check-runs\/(\d+)\/annotations$/);
  if (notes) return demoNotes[notes[1]] || [];
  if (path.endsWith("/dispatches")) return null;
  throw new AppError(`demo: caminho desconhecido ${path}`, 404);
}

/* ---------- start ---------- */

renderCabinFields();
bind();
const lastView = readStore("last_view", "searches");
showView(!DEMO && !config().token ? "settings" : VIEW_TITLES[lastView] ? lastView : "searches");
if (!DEMO && !config().token) {
  banner("Para começar, crie a chave de acesso do GitHub (passo a passo abaixo).");
}
