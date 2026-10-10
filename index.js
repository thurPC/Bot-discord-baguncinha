const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  Partials,
  ContextMenuCommandBuilder,
  ApplicationCommandType
} = require("discord.js");
const http = require("http");
const fs = require("fs");
const path = require("path");

// =========================
// CONFIGURAÇÃO
// =========================
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = "1370256381701128192";
const PORT = process.env.PORT || 10000;
const THESPORTSDB_KEY = process.env.THESPORTSDB_KEY || "3";

// ID do Discord de quem pode mudar as imagens da loja (só você).
// Configure a variável OWNER_ID no Render.
const OWNER_ID = process.env.OWNER_ID;

// itemId -> URL da imagem mostrada na prévia/compra (só o dono altera via /lojaimagem)
let lojaImagens = {};

// =========================
// VERIFICAÇÃO
// =========================
if (!TOKEN) {
  console.error("❌ TOKEN não configurado!");
}
if (!CLIENT_ID) {
  console.error("❌ CLIENT_ID não configurado!");
}

// =========================
// CLIENTE DISCORD
// =========================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// =========================
// "BANCO DE DADOS" EM MEMÓRIA (XP)
// ⚠️ Isso zera toda vez que o bot reinicia.
// Pra persistir de verdade, depois dá pra trocar por um arquivo JSON ou um banco (SQLite/Supabase).
// =========================
// XP de texto e de voz são contados separadamente (níveis independentes),
// mas os dois somam pro "nível total", que é o que libera os cargos por atividade.
const xpData = new Map(); // key: userId, value: { textXp, textLevel, voiceXp, voiceLevel, lastMessageTimestamp }

// =========================
// PERSISTÊNCIA EM JSON
// =========================
// ⚠️ O disco do Render é temporário: sobrevive a "dormir e acordar", mas
// some quando você faz um novo deploy (o container é recriado do zero).
const DATA_FILE = path.join(__dirname, "database.json");

// =========================
// BACKUP PERMANENTE NO GITHUB
// =========================
// O disco do Render é apagado a cada deploy, então o progresso também é salvo
// num arquivo dentro do seu repositório do GitHub, numa branch separada
// (GITHUB_DATA_BRANCH, padrão "dados"). Branch separada = o Render NÃO faz
// redeploy a cada salvamento (ele só observa a "main").
//
// Variáveis de ambiente no Render:
//   GITHUB_TOKEN        (obrigatória) token com permissão de escrever em "Contents"
//   GITHUB_REPO         (opcional)    padrão: thurPC/Bot-discord-baguncinha
//   GITHUB_DATA_BRANCH  (opcional)    padrão: dados
//
// ⚠️ Repositório PÚBLICO = os dados (IDs do Discord e moedas) ficam visíveis pra
// qualquer um. Se isso incomodar, aponte GITHUB_REPO pra um repositório PRIVADO.
function limparSegredo(valor) {
  if (!valor) return "";
  return String(valor)
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^(Bearer|token)\s+/i, "");
}

function normalizarRepo(repo) {
  return limparSegredo(repo)
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "");
}

const GITHUB_TOKEN = limparSegredo(process.env.GITHUB_TOKEN);
const GITHUB_REPO = normalizarRepo(process.env.GITHUB_REPO || "thurPC/Bot-discord-baguncinha");
const GITHUB_DATA_BRANCH = limparSegredo(process.env.GITHUB_DATA_BRANCH) || "dados";
const GITHUB_DATA_PATH = "database.json";
const GITHUB_SAVE_INTERVAL_MS = 5 * 60 * 1000; // no máximo 1 commit a cada 5 min

let githubSha = null;        // "versão" atual do arquivo no GitHub (necessária pra atualizar)
let dadosAlterados = false;  // true = tem coisa nova que ainda não foi pro GitHub
let salvandoGithub = false;  // evita dois salvamentos ao mesmo tempo
let ultimoTextoEnviado = null; // conteúdo do último envio (pra não commitar sem mudança)
let economiaResetVersao = 0;   // versão do último reset de saldos aplicado (ver resetarEconomia)
let top1Estado = { userId: null, since: 0, roleGranted: false };

// Reset único da economia: zera os saldos que ficaram inflados pelo bug dos
// marcos de moedas. Guardamos a versão aplicada junto dos dados pra rodar só uma
// vez — suba esse número caso precise resetar de novo no futuro.
const ECONOMIA_RESET_VERSAO = 1;

function resetarEconomia() {
  let afetados = 0;
  for (const data of xpData.values()) {
    if (data.coins !== 0 || data.banco !== 0 || (data.milestonesAlcancados && data.milestonesAlcancados.length > 0)) {
      afetados++;
    }
    data.coins = 0;
    data.banco = 0;
    data.milestonesAlcancados = [];
  }
  return afetados;
}

// Tudo que vai pro disco/GitHub: dados dos usuários + imagens da loja + a versão
// do último reset de economia aplicado (pra rodar o reset uma única vez).
function dadosParaSalvar() {
  return {
    ...Object.fromEntries(xpData),
    __lojaImagens: lojaImagens,
    __economiaReset: economiaResetVersao,
    __top1: top1Estado
  };
}

function githubErroAuth(status, json) {
  if (status !== 401 && status !== 403) return null;
  const detalhe = json?.message || "sem detalhes";
  return `GitHub recusou o token (${status}: ${detalhe}). Confere GITHUB_TOKEN no Render: precisa ser um Personal Access Token com permissão Contents (leitura e escrita) no repo ${GITHUB_REPO}. Tokens fine-grained precisam marcar Contents: Read and write; tokens clássicos precisam do scope "repo".`;
}

async function githubRequest(metodo, caminho, corpo) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "bot-baguncinha"
    };

    if (GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
    }

    if (corpo) {
      headers["Content-Type"] = "application/json";
    }

    const resposta = await fetch(`https://api.github.com${caminho}`, {
      method: metodo,
      headers,
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: controller.signal
    });

    let json = null;
    try {
      json = await resposta.json();
    } catch {
      json = null;
    }

    return { status: resposta.status, ok: resposta.ok, json };
  } finally {
    clearTimeout(timeoutId);
  }
}

function githubChecarResposta(r, acao) {
  const erroAuth = githubErroAuth(r.status, r.json);
  if (erroAuth) throw new Error(erroAuth);
  if (!r.ok) {
    throw new Error(`GitHub respondeu ${r.status} ao ${acao} (${r.json?.message || "sem detalhes"})`);
  }
}

// Baixa o banco de dados do GitHub. Retorna o objeto, ou null se não existir ainda.
async function githubCarregar() {
  const r = await githubRequest(
    "GET",
    `/repos/${GITHUB_REPO}/contents/${GITHUB_DATA_PATH}?ref=${encodeURIComponent(GITHUB_DATA_BRANCH)}`
  );

  if (r.status === 404) return null; // branch ou arquivo ainda não existem

  githubChecarResposta(r, "carregar");

  githubSha = r.json.sha;
  const texto = Buffer.from(r.json.content, "base64").toString("utf-8");
  const objeto = JSON.parse(texto);
  ultimoTextoEnviado = JSON.stringify(objeto, null, 2);
  return objeto;
}

async function githubShaDaBranchPadrao() {
  const repo = await githubRequest("GET", `/repos/${GITHUB_REPO}`);
  githubChecarResposta(repo, `ler o repositório ${GITHUB_REPO}`);

  const nomes = [];
  if (repo.json?.default_branch) nomes.push(repo.json.default_branch);
  for (const nome of ["main", "master"]) {
    if (!nomes.includes(nome)) nomes.push(nome);
  }

  for (const nome of nomes) {
    const ref = await githubRequest("GET", `/repos/${GITHUB_REPO}/git/ref/heads/${encodeURIComponent(nome)}`);
    const erroAuth = githubErroAuth(ref.status, ref.json);
    if (erroAuth) throw new Error(erroAuth);
    if (ref.ok && ref.json?.object?.sha) return ref.json.object.sha;
  }

  throw new Error(`Não achei a branch padrão do GitHub (tentei: ${nomes.join(", ")}). Confere GITHUB_REPO (${GITHUB_REPO}).`);
}

// Cria a branch de dados (a partir da branch padrão) se ela ainda não existir
async function githubGarantirBranch() {
  const existe = await githubRequest(
    "GET",
    `/repos/${GITHUB_REPO}/git/ref/heads/${encodeURIComponent(GITHUB_DATA_BRANCH)}`
  );
  if (existe.ok) return;

  const erroAuth = githubErroAuth(existe.status, existe.json);
  if (erroAuth) throw new Error(erroAuth);

  if (existe.status !== 404) {
    throw new Error(`Não consegui verificar a branch "${GITHUB_DATA_BRANCH}" (${existe.status}: ${existe.json?.message || "sem detalhes"}).`);
  }

  const shaBase = await githubShaDaBranchPadrao();
  const criada = await githubRequest("POST", `/repos/${GITHUB_REPO}/git/refs`, {
    ref: `refs/heads/${GITHUB_DATA_BRANCH}`,
    sha: shaBase
  });

  if (!criada.ok && criada.status !== 422) {
    const auth = githubErroAuth(criada.status, criada.json);
    if (auth) throw new Error(auth);
    throw new Error(`Não consegui criar a branch "${GITHUB_DATA_BRANCH}" (${criada.status}: ${criada.json?.message || "sem detalhes"}).`);
  }

  console.log(`🌿 Branch "${GITHUB_DATA_BRANCH}" criada no GitHub.`);
}

async function githubSalvar() {
  if (!GITHUB_TOKEN || salvandoGithub) return;

  salvandoGithub = true;
  dadosAlterados = false; // se alguém mexer durante o envio, vira true de novo

  try {
    const texto = JSON.stringify(dadosParaSalvar(), null, 2);

    // nada mudou desde o último envio? então não gasta um commit à toa
    if (texto === ultimoTextoEnviado) {
      return;
    }

    const conteudo = Buffer.from(texto).toString("base64");

    if (githubSha === null) {
      await githubGarantirBranch();

      // pode já existir um arquivo lá que a gente ainda não conhecia — pega o sha dele
      const atual = await githubRequest(
        "GET",
        `/repos/${GITHUB_REPO}/contents/${GITHUB_DATA_PATH}?ref=${encodeURIComponent(GITHUB_DATA_BRANCH)}`
      );
      if (atual.ok) githubSha = atual.json.sha;
    }

    const enviar = () =>
      githubRequest("PUT", `/repos/${GITHUB_REPO}/contents/${GITHUB_DATA_PATH}`, {
        message: `backup automático (${xpData.size} usuários)`,
        content: conteudo,
        branch: GITHUB_DATA_BRANCH,
        ...(githubSha ? { sha: githubSha } : {})
      });

    let r = await enviar();

    // Se o sha estava desatualizado, busca o atual e tenta uma vez de novo
    if (r.status === 409 || r.status === 422) {
      const atual = await githubRequest(
        "GET",
        `/repos/${GITHUB_REPO}/contents/${GITHUB_DATA_PATH}?ref=${encodeURIComponent(GITHUB_DATA_BRANCH)}`
      );
      githubSha = atual.ok ? atual.json.sha : null;
      r = await enviar();
    }

    githubChecarResposta(r, "salvar");

    githubSha = r.json.content.sha;
    ultimoTextoEnviado = texto;
    console.log(`☁️ Progresso salvo no GitHub (${xpData.size} usuário(s)).`);
  } catch (error) {
    dadosAlterados = true; // tenta de novo no próximo ciclo
    console.error("❌ Erro ao salvar no GitHub:", error.message);
  } finally {
    salvandoGithub = false;
  }
}

function aplicarDadosCarregados(objeto) {
  for (const [chave, valor] of Object.entries(objeto)) {
    // chave especial: imagens da loja (não é um usuário)
    if (chave === "__lojaImagens") {
      lojaImagens = valor || {};
      continue;
    }
    // chave especial: versão do reset de economia já aplicado
    if (chave === "__economiaReset") {
      economiaResetVersao = Number(valor) || 0;
      continue;
    }
    if (chave === "__top1") {
      top1Estado = {
        userId: valor?.userId || null,
        since: Number(valor?.since) || 0,
        roleGranted: valor?.roleGranted === true
      };
      continue;
    }
    xpData.set(chave, normalizarDadosUsuario(valor));
  }
}

// Roda o reset de economia só uma vez por versão. Precisa ser chamado depois de
// carregar os dados (GitHub ou disco) e antes do bot começar a responder.
function aplicarResetEconomiaSeNecessario() {
  if (economiaResetVersao >= ECONOMIA_RESET_VERSAO) return;

  const afetados = resetarEconomia();
  economiaResetVersao = ECONOMIA_RESET_VERSAO;
  salvarDados(); // já persiste o reset no disco e agenda o envio pro GitHub
  console.log(`♻️ Reset de economia aplicado (v${ECONOMIA_RESET_VERSAO}) — ${afetados} carteira(s) zerada(s).`);
}

async function githubValidarAcesso() {
  const repo = await githubRequest("GET", `/repos/${GITHUB_REPO}`);
  githubChecarResposta(repo, `acessar o repositório ${GITHUB_REPO}`);

  const permissoes = repo.json?.permissions || {};
  if (permissoes.push === false) {
    throw new Error(
      `O token acessa ${GITHUB_REPO}, mas não tem permissão de escrita. No GitHub: Settings > Developer settings > Personal access tokens — Contents precisa ser Read and write (fine-grained) ou scope "repo" (clássico).`
    );
  }

  console.log(`☁️ GitHub ok: ${GITHUB_REPO} (branch de dados: ${GITHUB_DATA_BRANCH}).`);
}

async function carregarDados() {
  // 1) GitHub é a fonte principal (sobrevive a deploy)
  if (GITHUB_TOKEN) {
    try {
      await githubValidarAcesso();
      const doGithub = await githubCarregar();
      if (doGithub) {
        aplicarDadosCarregados(doGithub);
        console.log(`☁️ Banco de dados carregado do GitHub (${xpData.size} usuário(s)).`);
        return;
      }
      console.log("☁️ Ainda não tem backup no GitHub — vai ser criado no primeiro salvamento.");
    } catch (error) {
      console.error("❌ Erro ao carregar do GitHub (tentando o arquivo local):", error.message);
    }
  } else {
    console.log("⚠️ GITHUB_TOKEN não configurado — o progresso só fica salvo no disco do Render (some a cada deploy).");
  }

  // 2) Plano B: arquivo local
  try {
    if (fs.existsSync(DATA_FILE)) {
      aplicarDadosCarregados(JSON.parse(fs.readFileSync(DATA_FILE, "utf-8")));
      console.log(`💾 Banco de dados carregado do disco (${xpData.size} usuário(s)).`);
    } else {
      console.log("💾 Nenhum banco de dados encontrado, começando do zero.");
    }
  } catch (error) {
    console.error("❌ Erro ao carregar banco de dados local:", error);
  }
}

// Salva no disco na hora e marca pra subir pro GitHub no próximo ciclo
function salvarDados() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(dadosParaSalvar(), null, 2));
    dadosAlterados = true;
  } catch (error) {
    console.error("❌ Erro ao salvar banco de dados:", error);
  }
}

// Garante que TODO usuário (inclusive os antigos, carregados do GitHub/disco)
// tenha todos os campos com tipo/valor válidos. Sem isso, contas criadas por
// versões anteriores ficavam com `coins` indefinido, e qualquer ganho virava
// NaN — que aparecia como "undefined" no /rankmoedas e estourava os totais.
function normalizarDadosUsuario(data) {
  if (!data || typeof data !== "object") data = {};
  const numero = (valor, padrao = 0) =>
    typeof valor === "number" && Number.isFinite(valor) ? valor : padrao;

  data.textXp = numero(data.textXp);
  data.textLevel = numero(data.textLevel, 1);
  data.voiceXp = numero(data.voiceXp);
  data.voiceLevel = numero(data.voiceLevel, 1);
  data.lastMessageTimestamp = numero(data.lastMessageTimestamp);
  data.coins = numero(data.coins);
  data.banco = numero(data.banco);
  data.lastDaily = numero(data.lastDaily);
  data.lastTrabalhar = numero(data.lastTrabalhar);
  data.lastPescar = numero(data.lastPescar);
  data.lastRoubar = numero(data.lastRoubar);
  data.lastRoleta = numero(data.lastRoleta);
  data.presoAte = numero(data.presoAte);
  data.turboTrabalhar = data.turboTrabalhar === true;
  data.xpBoostAte = numero(data.xpBoostAte);
  data.ticketsSorteio = numero(data.ticketsSorteio);
  data.conquistas = Array.isArray(data.conquistas) ? data.conquistas : [];
  data.itemLendario = data.itemLendario === true;
  data.milestonesAlcancados = Array.isArray(data.milestonesAlcancados) ? data.milestonesAlcancados : [];
  data.comandosDesdeRank = numero(data.comandosDesdeRank);

  return data;
}

function getUserData(userId) {
  if (!xpData.has(userId)) {
    xpData.set(userId, {
      textXp: 0,
      textLevel: 1,
      voiceXp: 0,
      voiceLevel: 1,
      lastMessageTimestamp: 0,
      coins: 0,
      banco: 0,                // moedas guardadas no banco (protegidas de roubo)
      lastDaily: 0,
      lastTrabalhar: 0,
      lastPescar: 0,
      lastRoubar: 0,
      lastRoleta: 0,           // cooldown da /roleta
      presoAte: 0,             // timestamp — enquanto Date.now() < isso, não dá pra trabalhar/pescar/roubar
      turboTrabalhar: false,   // true depois de comprar o item que reduz o cooldown do /trabalhar
      xpBoostAte: 0,           // timestamp — enquanto Date.now() < isso, XP em dobro
      ticketsSorteio: 0,       // quantos bilhetes de sorteio a pessoa tem
      conquistas: [],          // ids de conquistas já desbloqueadas
      itemLendario: false,     // flag de quem já tirou o prêmio raro da caixa/roleta
      milestonesAlcancados: [], // marcos de moeda (10k, 20k...) já anunciados/recompensados
      comandosDesdeRank: 0     // ranking aparece a cada 8 comandos por pessoa
    });
  }

  // Compatibilidade: normaliza contas antigas/incompletas e devolve o objeto.
  return normalizarDadosUsuario(xpData.get(userId));
}

function xpForNextLevel(level, type) {
  // Meta de voz é maior que a de texto, pra call longa não subir de nível rápido demais.
  const base = type === "voice" ? 200 : 100;
  return level * base;
}

function getTotalLevel(data) {
  // Cargo por atividade considera o MAIOR nível entre texto e voz
  // (não soma os dois, pra call longa não destravar cargo rápido demais)
  return Math.max(data.textLevel, data.voiceLevel);
}

function obterRankingXp(limite = 10) {
  return [...xpData.entries()]
    .filter(([userId]) => userId && !String(userId).startsWith("__"))
    .sort((a, b) => {
      const totalA = getTotalLevel(a[1]);
      const totalB = getTotalLevel(b[1]);
      if (totalB !== totalA) return totalB - totalA;
      return (b[1].textXp + b[1].voiceXp) - (a[1].textXp + a[1].voiceXp);
    })
    .slice(0, limite);
}

async function montarEmbedRanking(limite = 10) {
  const ranking = obterRankingXp(limite);

  if (ranking.length === 0) {
    return new EmbedBuilder()
      .setTitle("Ranking")
      .setDescription("Ainda nao rolou nada por aqui. Manda umas mensagens ou entra em call!")
      .setColor(0xfee75c);
  }

  const MEDALHAS = ["🥇", "🥈", "🥉"];
  const usuarios = await Promise.all(
    ranking.map(([userId]) => client.users.fetch(userId).catch(() => null))
  );

  const linhas = ranking.map(([, data], index) => {
    const user = usuarios[index];
    const nome = user ? user.username : "Usuário desconhecido";
    const posicao = MEDALHAS[index] || `**${index + 1}.**`;
    return (
      `${posicao} **${nome}** — Nível ${getTotalLevel(data)}\n` +
      `　　💬 Texto: ${data.textLevel}  •  🎙️ Voz: ${data.voiceLevel}`
    );
  });

  return new EmbedBuilder()
    .setTitle("🏆 **Ranking**")
    .setDescription(linhas.join("\n\n"))
    .setColor(0xfee75c)
    .setThumbnail(usuarios[0]?.displayAvatarURL({ size: 256 }) || null)
    .setFooter({ text: `Top ${ranking.length} de atividade no servidor` });
}

async function ensureTop1Role(guild) {
  if (!guild) return null;
  await guild.roles.fetch().catch(() => {});

  if (top1RoleId && guild.roles.cache.has(top1RoleId)) {
    return guild.roles.cache.get(top1RoleId);
  }

  let cargo = guild.roles.cache.find(r => r.name.toLowerCase() === TOP1_ROLE_NAME.toLowerCase());
  if (!cargo) {
    try {
      cargo = await guild.roles.create({
        name: TOP1_ROLE_NAME,
        color: 0xffd700,
        hoist: true,
        mentionable: false,
        reason: "Cargo automatico para quem fica no 1 lugar do ranking por 3 dias"
      });
      console.log(`Cargo Top 1 criado: ${cargo.id}`);
    } catch (error) {
      console.error("Nao consegui criar o cargo Top 1:", error.message);
      return null;
    }
  }

  top1RoleId = cargo.id;
  return cargo;
}

let atualizandoTop1 = false;

async function atualizarTop1(guild) {
  if (!guild || atualizandoTop1) return;
  atualizandoTop1 = true;
  try {
    const ranking = obterRankingXp(1);
    const liderId = ranking[0]?.[0] || null;
    const agora = Date.now();
    const cargo = await ensureTop1Role(guild);

    if (!liderId) return;

    if (top1Estado.userId !== liderId) {
      const antigoId = top1Estado.userId;
      const tinhaCargo = top1Estado.roleGranted;

      if (antigoId && cargo) {
        const antigo = await guild.members.fetch(antigoId).catch(() => null);
        if (antigo && antigo.roles.cache.has(cargo.id)) {
          await antigo.roles.remove(cargo).catch(() => {});
        }

        if (tinhaCargo) {
          const canal = guild.systemChannel;
          if (canal) {
            await canal.send(
              `<@${antigoId}> perdeu o cargo **${TOP1_ROLE_NAME}**! <@${liderId}> assumiu o 1 lugar do ranking.`
            ).catch(() => {});
          }

          const dmAntigo = await client.users.fetch(antigoId).catch(() => null);
          if (dmAntigo) {
            await dmAntigo.send(
              `Voce perdeu o cargo **${TOP1_ROLE_NAME}** no servidor **${guild.name}**. Alguem tomou o 1 lugar do ranking.`
            ).catch(() => {});
          }
        }
      }

      top1Estado = { userId: liderId, since: agora, roleGranted: false };
      salvarDados();
      return;
    }

    if (!top1Estado.since) {
      top1Estado.since = agora;
      salvarDados();
      return;
    }

    if (!top1Estado.roleGranted && agora - top1Estado.since >= TOP1_DIAS_MS) {
      const recompensaTop1 = 2000;
      const dataLider = getUserData(liderId);
      dataLider.coins += recompensaTop1;

      if (cargo) {
        const membro = await guild.members.fetch(liderId).catch(() => null);
        if (membro && !membro.roles.cache.has(cargo.id)) {
          await membro.roles.add(cargo).catch(() => {});
        }
        const canal = guild.systemChannel;
        if (canal) {
          await canal.send(
            `<@${liderId}> ficou em **1 lugar** por mais de 3 dias e ganhou o cargo **${TOP1_ROLE_NAME}** + ${formatarMoedas(recompensaTop1)}!`
          ).catch(() => {});
        }
      }
      top1Estado.roleGranted = true;
      salvarDados();
    }
  } finally {
    atualizandoTop1 = false;
  }
}

// type: "text" ou "voice" — cada um tem seu próprio XP/nível
function addXp(userId, amount, type) {
  const data = getUserData(userId);
  const xpKey = type === "voice" ? "voiceXp" : "textXp";
  const levelKey = type === "voice" ? "voiceLevel" : "textLevel";

  // XP Boost da loja: dobra o ganho enquanto estiver ativo
  if (Date.now() < data.xpBoostAte) {
    amount *= 2;
  }

  data[xpKey] += amount;

  let leveledUp = false;
  while (data[xpKey] >= xpForNextLevel(data[levelKey], type)) {
    data[xpKey] -= xpForNextLevel(data[levelKey], type);
    data[levelKey] += 1;
    leveledUp = true;
  }

  return { data, leveledUp };
}

// =========================
// CARGOS POR NÍVEL (ATIVIDADE)
// =========================
// Coloque aqui o nível mínimo e o ID do cargo correspondente.
// Copie o ID do cargo no Discord com o Modo Desenvolvedor ativado.
// O cargo do bot precisa estar ACIMA desses cargos na hierarquia,
// e o bot precisa da permissão "Gerenciar Cargos".
const LEVEL_ROLES = {
  4: "1546574924448141484",   // ex: Membro Ativo
  10: "1552496174882234479",  // ex: Veterano
  20: "1552497344270958674"   // ex: Lenda do Servidor
};

function getRoleIdForLevel(level) {
  let targetRoleId = null;
  let highestThreshold = 0;

  for (const [threshold, roleId] of Object.entries(LEVEL_ROLES)) {
    const t = Number(threshold);
    if (level >= t && t > highestThreshold) {
      highestThreshold = t;
      targetRoleId = roleId;
    }
  }

  return targetRoleId;
}

async function updateLevelRole(guild, userId, level) {
  const targetRoleId = getRoleIdForLevel(level);
  if (!targetRoleId || targetRoleId.startsWith("COLOQUE_")) return null;

  try {
    const member = await guild.members.fetch(userId);
    if (member.roles.cache.has(targetRoleId)) return null; // já tem

    // Remove cargos de nível anteriores (pra ficar só com o mais alto)
    const allLevelRoleIds = Object.values(LEVEL_ROLES).filter(
      id => !id.startsWith("COLOQUE_")
    );
    const rolesToRemove = allLevelRoleIds.filter(
      id => id !== targetRoleId && member.roles.cache.has(id)
    );
    if (rolesToRemove.length > 0) {
      await member.roles.remove(rolesToRemove).catch(() => {});
    }

    await member.roles.add(targetRoleId);
    return targetRoleId;
  } catch (error) {
    console.error("❌ Erro ao atribuir cargo por nível:");
    console.error(error);
    return null;
  }
}

// =========================
// ECONOMIA — MOEDAS
// =========================
const DAILY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const DAILY_MIN = 250;
const DAILY_MAX = 500;
const TOP1_DIAS_MS = 3 * 24 * 60 * 60 * 1000;
const TOP1_ROLE_NAME = "Top 1";
let top1RoleId = process.env.TOP1_ROLE_ID || null;
const TRABALHAR_COOLDOWN_NORMAL_MS = 60 * 60 * 1000;
const TRABALHAR_COOLDOWN_TURBO_MS = 25 * 60 * 1000; // com o item "Turbo Trabalhar" da loja
const PESCAR_COOLDOWN_MS = 8 * 60 * 1000;
const ROUBAR_COOLDOWN_MS = 20 * 1000;
const PRISAO_MS = 35 * 60 * 1000; // tempo preso ao falhar um roubo
const ROLETA_COOLDOWN_MS = 60 * 1000;
const ROLETA_APOSTA_MIN = 150;
const ROLETA_APOSTA_MAX = 20000;
const PPT_APOSTA_MIN = 100;
const PPT_APOSTA_MAX = 5000;

// --- Banco / Roubo ---
// O banco guarda moedas e te protege dos roubos sofridos (só a carteira pode ser
// assaltada). Quem é pego roubando paga multa de 40% do valor TOTAL da vítima
// (carteira + banco), debitando primeiro da carteira e depois do banco.
const ROUBO_MULTA_PERCENTUAL = 0.4;
const ROUBO_MIN_VITIMA = 50;        // a vítima precisa ter pelo menos isso na CARTEIRA pra valer a pena
const ROUBO_SAQUE_MIN = 0.5;        // fração mínima da carteira roubada ao vencer o minigame
const ROUBO_SAQUE_MAX = 0.8;        // fração máxima da carteira roubada ao vencer o minigame

// Minigame de memória: 3 fases, sequências maiores e tempo curto. Acertar tudo
// dá um saque alto; errar uma vez (ou estourar o tempo) = preso + multa.
const ROUBO_SIMBOLOS = ["🍎", "🍌", "🍇", "🍒", "🍉", "🍋"];
const ROUBO_RODADAS = [
  { tamanho: 4, mostrarMs: 3500, jogarMs: 12000 },
  { tamanho: 5, mostrarMs: 3500, jogarMs: 12000 },
  { tamanho: 6, mostrarMs: 5500, jogarMs: 15000 }
];

function getTotalMoedas(data) {
  return (data.coins || 0) + (data.banco || 0);
}

function getTrabalharCooldown(data) {
  return data.turboTrabalhar ? TRABALHAR_COOLDOWN_TURBO_MS : TRABALHAR_COOLDOWN_NORMAL_MS;
}

function formatarMoedas(valor) {
  const numero = Number(valor);
  const exibicao = Number.isFinite(numero) ? Math.floor(numero).toLocaleString("pt-BR") : "0";
  return `${exibicao} 🪙`;
}

// Bloqueia trabalhar/pescar/roubar enquanto a pessoa tá "presa" por ter falhado um roubo.
// Retorna a mensagem de erro pronta, ou null se a pessoa não tá presa.
function checarPrisao(data) {
  const restante = data.presoAte - Date.now();
  if (restante <= 0) return null;

  const minutos = Math.ceil(restante / 60000);
  return `🚔 Você tá preso ainda! Nada de trabalhar, pescar ou roubar por mais ~${minutos} min.`;
}

// =========================
// MARCOS DE MOEDAS
// =========================
// A cada 10.000 moedas acumuladas, o bot anuncia e dá uma recompensa fixa —
// só uma vez por marco por pessoa.
//
// IMPORTANTE (correção): antes a recompensa crescia 3.000 por marco e podia
// desbloquear o próximo marco dentro do mesmo cálculo. Isso se realimentava e
// fazia a carteira explodir (ex.: quem tinha 690k ganhava ~200k de uma vez).
// Agora a recompensa é CONSTANTE e NÃO conta pra desbloquear novos marcos, então
// o dinheiro novo continua vindo das atividades/jogos, não dos marcos.
const MOEDA_MARCO_INTERVALO = 10000;
const MOEDA_MARCO_RECOMPENSA = 1000;

function calcularRecompensaMarco(/* marco */) {
  return MOEDA_MARCO_RECOMPENSA;
}

async function verificarMarcosMoedas(guild, userId, data) {
  if (!guild || !data) return;
  if (!Array.isArray(data.milestonesAlcancados)) data.milestonesAlcancados = [];
  if (typeof data.coins !== "number" || !Number.isFinite(data.coins)) data.coins = 0;

  // Marcos são calculados pelo saldo ATUAL (antes da recompensa). A recompensa
  // não empurra pra novos marcos — evita a bola de neve que inflacionava tudo.
  const marcoMaximoAtingido = Math.floor(data.coins / MOEDA_MARCO_INTERVALO) * MOEDA_MARCO_INTERVALO;
  if (marcoMaximoAtingido < MOEDA_MARCO_INTERVALO) return;

  const novosMarcos = [];
  for (let m = MOEDA_MARCO_INTERVALO; m <= marcoMaximoAtingido; m += MOEDA_MARCO_INTERVALO) {
    if (!data.milestonesAlcancados.includes(m)) novosMarcos.push(m);
  }

  if (novosMarcos.length === 0) return;

  let recompensaTotal = 0;
  for (const marco of novosMarcos) {
    data.milestonesAlcancados.push(marco);
    recompensaTotal += calcularRecompensaMarco(marco);
  }
  data.coins += recompensaTotal;

  const ultimoMarco = novosMarcos[novosMarcos.length - 1];
  const canal = guild.systemChannel;
  if (canal) {
    const embed = new EmbedBuilder()
      .setTitle("💰 Novo marco de moedas!")
      .setDescription(
        `<@${userId}> chegou em **${ultimoMarco.toLocaleString("pt-BR")} moedas** no servidor! 🎉\n` +
        `Recompensa por bater essa meta: ${formatarMoedas(recompensaTotal)}`
      )
      .setColor(0xf1c40f);

    canal.send({ embeds: [embed] }).catch(() => {});
  }
}

// =========================
// BAGUNCINHA STORE
// =========================
// Categorias e itens da loja. Preencha os "COLOQUE_..." com IDs reais de cargo
// quando for usar. tipo decide o que acontece na hora da compra:
//   "cargo"            -> dá um cargo cosmético
//   "turbo_trabalhar"  -> reduz o cooldown do /trabalhar pra sempre
//   "xp_boost"         -> dobra XP por 1h
//   "caixa"            -> abre uma caixa misteriosa com prêmio aleatório
//   "ticket"           -> dá 1 bilhete pro sorteio
// Enquanto o roleId começar com "COLOQUE_", a compra é cancelada sem cobrar.
const LOJA_CATEGORIAS = {
  boosts: { nome: "⚡ Boosts", descricao: "Vantagens permanentes ou temporárias." },
  cargos: { nome: "👑 Cargos", descricao: "Cargos personalizados e especiais." },
  caixas: { nome: "📦 Caixas Misteriosas", descricao: "Aposta na sorte por uma recompensa aleatória." },
  bilhetes: { nome: "🎫 Sorteio", descricao: "Bilhetes pra concorrer a prêmios do servidor." }
};

const LOJA_ITEMS = {
  turbo_trabalhar: {
    categoria: "boosts",
    nome: "⏱️ Turbo Trabalhar",
    preco: 5000,
    descricao: "Reduz o tempo do `/trabalhar` de 60 pra 25 minutos. Permanente.",
    tipo: "turbo_trabalhar"
  },
  xp_boost: {
    categoria: "boosts",
    nome: "✨ XP Boost (2x por 1h)",
    preco: 1500,
    descricao: "Dobra o XP ganho (texto e voz) pela próxima 1 hora.",
    tipo: "xp_boost"
  },
  cargo_pirata: {
    categoria: "cargos",
    nome: " Cargo Pirata",
    preco: 10000,
    descricao: "desbloquea canais pir2tas no servidor.",
    tipo: "cargo",
    roleId: "1530739542733230251"
  },
  cargo_neon: {
    categoria: "cargos",
    nome: "Cargo (??)",
    preco: 12000,
    descricao: "???",
    tipo: "cargo",
    roleId: ""
  },

  // ---- 11 cargos novos (troque os COLOQUE_ID_x pelos IDs reais; nomes/preços são sugestões) ----
  cargo_celestial: {
    categoria: "cargos",
    nome: "Cargo Celestial",
    preco: 5000,
    descricao: "Mídia.",
    tipo: "cargo",
    roleId: "1554311367199031396"
  },
  cargo_pelėzi: {
    categoria: "cargos",
    nome: "Cargo Pelėzin",
    preco: 3500,
    descricao: "pelé?.",
    tipo: "cargo",
    roleId: "1554318597520887808"
  },
  cargo_67: {
    categoria: "cargos",
    nome: "Cargo 67",
    preco: 3500,
    descricao: "aura.",
    tipo: "cargo",
    roleId: "1554315725047332905"
  },
  cargo_monge: {
    categoria: "cargos",
    nome: "Cargo Monge",
    preco: 2500,
    descricao: "?",
    tipo: "cargo",
    roleId: "1554310974020784189"
  },
  cargo_Supremo: {
    categoria: "cargos",
    nome: "Cargo Supremo",
    preco: 8000,
    descricao: "supremo.",
    tipo: "cargo",
    roleId: "1554313350043664464"
  },
  cargo_157: {
    categoria: "cargos",
    nome: "Cargo 157",
    preco: 4000,
    descricao: "🚩",
    tipo: "cargo",
    roleId: "1554315527021658152"
  },
  cargo_171: {
    categoria: "cargos",
    nome: "Cargo 171",
    preco: 4000,
    descricao: "Estelionatario bigode?",
    tipo: "cargo",
    roleId: "1554315568125845525"
  },
  cargo_777: {
    categoria: "cargos",
    nome: "Cargo 777",
    preco: 7770,
    descricao: "🎰",
    tipo: "cargo",
    roleId: "1554315611281166366"
  },
  cargo_coroa: {
    categoria: "cargos",
    nome: "Cargo Coroa",
    preco: 3500,
    descricao: "duo Cara?.",
    tipo: "cargo",
    roleId: "1554318085027143821"
  },
  cargo_cara: {
    categoria: "cargos",
    nome: "Cargo Cara",
    preco: 3500,
    descricao: "duo coroa?.",
    tipo: "cargo",
    roleId: "1554317867422322728"
  },
  cargo_milionario: {
    categoria: "cargos",
    nome: "Cargo Milionario",
    preco: 15000,
    descricao: "mostra quem e o mais rico.",
    tipo: "cargo",
    roleId: "1553051456293048540"
  },

  caixa_baguncinha: {
    categoria: "caixas",
    nome: "📦 Caixa Baguncinha",
    preco: 2000,
    descricao: "Pode vir moedas, XP Boost, cargo temporário ou até item lendário, depende da sua sorte.",
    tipo: "caixa"
  },
  ticket_sorteio: {
    categoria: "bilhetes",
    nome: "🎫 Ticket de Sorteio",
    preco: 700,
    descricao: "1 bilhete = 1 chance no próximo sorteio. (staff usa `/sortear`).",
    tipo: "ticket"
  }
};

// =========================
// CAIXA MISTERIOSA — TABELA DE RARIDADE
// =========================
// "peso" define a chance (peso maior = mais comum). Soma dos pesos = 100.
// EV calibrado pra ficar abaixo do preço da caixa (2.000), mantendo a economia saudável.
const CARGO_TEMPORARIO_ID = "COLOQUE_O_ID_DO_CARGO_TEMPORARIO_AQUI"; // cargo de 24h, prêmio ÉPICO
const CAIXA_REWARDS = [
  { raridade: "COMUM", peso: 40, tipo: "moedas", valor: 500 },
  { raridade: "COMUM", peso: 25, tipo: "moedas", valor: 1000 },
  { raridade: "RARO", peso: 15, tipo: "moedas", valor: 3000 },
  { raridade: "RARO", peso: 10, tipo: "xp_boost", valor: null },
  { raridade: "ÉPICO", peso: 6, tipo: "cargo_temporario", valor: null },
  { raridade: "**LENDÁRIO**", peso: 3, tipo: "moedas", valor: 8000 },
  { raridade: "???", peso: 1, tipo: "jackpot", valor: 20000 }
];

const CORES_RARIDADE = {
  "COMUM": 0x95a5a6,
  "RARO": 0x3498db,
  "ÉPICO": 0x9b59b6,
  "LENDÁRIO": 0xf1c40f,
  "???": 0xe74c3c
};

function sortearRecompensaCaixa() {
  const totalPeso = CAIXA_REWARDS.reduce((soma, item) => soma + item.peso, 0);
  let sorteio = Math.random() * totalPeso;

  for (const recompensa of CAIXA_REWARDS) {
    if (sorteio < recompensa.peso) return recompensa;
    sorteio -= recompensa.peso;
  }

  return CAIXA_REWARDS[0]; // fallback, nunca deveria chegar aqui
}

async function aplicarRecompensaCaixa(member, data, recompensa) {
  let descricao = "";

  if (recompensa.tipo === "moedas") {
    data.coins += recompensa.valor;
    descricao = `Você ganhou ${formatarMoedas(recompensa.valor)}!`;
  } else if (recompensa.tipo === "xp_boost") {
    const agora = Date.now();
    data.xpBoostAte = Math.max(data.xpBoostAte, agora) + 60 * 60 * 1000;
    descricao = "Você ganhou **XP Boost 2x por 1 hora**!";
  } else if (recompensa.tipo === "cargo_temporario") {
    if (CARGO_TEMPORARIO_ID.startsWith("COLOQUE_")) {
      data.coins += 1000;
      descricao = "Você ganharia um cargo temporário, mas ele ainda não foi configurado — ganhou 1.000 🪙 no lugar.";
    } else {
      await member.roles.add(CARGO_TEMPORARIO_ID).catch(() => {});
      setTimeout(() => {
        member.roles.remove(CARGO_TEMPORARIO_ID).catch(() => {});
      }, 24 * 60 * 60 * 1000);
      descricao = "Você ganhou um **cargo temporário por 24 horas**!";
    }
  } else if (recompensa.tipo === "jackpot") {
    data.coins += recompensa.valor;
    data.itemLendario = true;
    descricao = `🎉 **JACKPOT SECRETO!** Você ganhou ${formatarMoedas(recompensa.valor)} e desbloqueou o item lendário místico!`;
  }

  return descricao;
}

// =========================
// ROLETA BAGUNCINHA
// =========================
// Pesos calibrados pra deixar uma leve vantagem da casa (EV ~0.95x da aposta),
// senão a roleta vira fonte infinita de moedas em vez de minigame.
const ROLETA_RESULTADOS = [
  { label: "❌ 0x — PERDEU TUDO", multiplicador: 0, peso: 35 },
  { label: "🔸 0.5x — Quase lá", multiplicador: 0.5, peso: 25 },
  { label: "🔹 1x — Empatou", multiplicador: 1, peso: 20 },
  { label: "🎉 2x — Dobrou!", multiplicador: 2, peso: 14 },
  { label: "🔥 5x — Grande vitória!", multiplicador: 5, peso: 5 },
  { label: "💎 JACKPOT **10X**!!! 💎", multiplicador: 10, peso: 1 }
];

function sortearRoleta() {
  const totalPeso = ROLETA_RESULTADOS.reduce((soma, item) => soma + item.peso, 0);
  let sorteio = Math.random() * totalPeso;

  for (const resultado of ROLETA_RESULTADOS) {
    if (sorteio < resultado.peso) return resultado;
    sorteio -= resultado.peso;
  }

  return ROLETA_RESULTADOS[0];
}

// =========================
// CONQUISTAS
// =========================
// Cada conquista tem uma condição pra checar e uma recompensa. O usuário
// roda /conquistas pra reivindicar as que já cumpriu — não é dado automático,
// assim a pessoa volta a interagir com o bot em vez de só ganhar tudo passivo.
const CONQUISTAS = {
  veterano: {
    nome: "🏆 **Veterano**",
    descricao: "Fique 30 dias no servidor.",
    condicao: member => Date.now() - member.joinedTimestamp >= 30 * 24 * 60 * 60 * 1000,
    moedas: 5000,
    roleId: "1552496174882234479",
    badge: "🎖️ Badge Veterano"
  }
};

async function verificarConquistas(member, data) {
  const desbloqueadas = [];

  for (const [id, conquista] of Object.entries(CONQUISTAS)) {
    if (data.conquistas.includes(id)) continue;
    if (!conquista.condicao(member)) continue;

    data.conquistas.push(id);
    data.coins += conquista.moedas;

    if (conquista.roleId && !conquista.roleId.startsWith("COLOQUE_")) {
      await member.roles.add(conquista.roleId).catch(() => {});
    }

    desbloqueadas.push(conquista);
  }

  return desbloqueadas;
}

// =========================
// UI DA LOJA (EMBED + MENUS + BOTÕES)
// =========================
function montarEmbedLojaPrincipal() {
  return new EmbedBuilder()
    .setTitle("🎪 **BAGUNCINHA STORE**")
    .setDescription(
      "Escolha uma categoria no menu abaixo pra ver os itens.\n\n" +
      Object.values(LOJA_CATEGORIAS).map(c => `${c.nome} — ${c.descricao}`).join("\n") +
      "\n\n🏆 Tem conquistas te esperando também — dá uma olhada no `/conquistas`."
    )
    .setColor(0x9b59b6)
    .setFooter({ text: "**Baguncinha Store**" });
}

function montarComponentesLojaPrincipal() {
  const linhaCategoria = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("loja_categoria")
      .setPlaceholder("📂 Escolher categoria")
      .addOptions(
        Object.entries(LOJA_CATEGORIAS).map(([id, cat]) => ({
          label: cat.nome,
          description: cat.descricao,
          value: id
        }))
      )
  );

  return [linhaCategoria];
}

function montarEmbedLojaCategoria(categoriaId) {
  const categoria = LOJA_CATEGORIAS[categoriaId];
  const itensCategoria = Object.entries(LOJA_ITEMS).filter(([, item]) => item.categoria === categoriaId);

  return new EmbedBuilder()
    .setTitle(`${categoria.nome} — BAGUNCINHA STORE`)
    .setDescription(
      itensCategoria
        .map(([, item]) => `**${item.nome}** — ${formatarMoedas(item.preco)}\n${item.descricao}`)
        .join("\n\n") +
      "\n\n👇 Escolha um item no menu pra ver a prévia antes de comprar."
    )
    .setColor(0x9b59b6)
    .setFooter({ text: "Baguncinha Store" });
}

// Menu de itens (até 25 opções) em vez de um botão por item —
// com tantos cargos, os botões estourariam o limite de 5 linhas do Discord.
function montarComponentesLojaCategoria(categoriaId) {
  const itensCategoria = Object.entries(LOJA_ITEMS).filter(([, item]) => item.categoria === categoriaId);

  const linhaItem = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("loja_item")
      .setPlaceholder("🔎 Escolher item (ver prévia)")
      .addOptions(
        itensCategoria.slice(0, 25).map(([id, item]) => ({
          label: item.nome.slice(0, 100),
          description: `${item.preco} moedas`,
          value: id
        }))
      )
  );

  const linhaVoltar = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("loja_voltar").setLabel("⬅️ Categorias").setStyle(ButtonStyle.Secondary)
  );

  return [linhaItem, linhaVoltar];
}

// Prévia do item (com a imagem que só o dono define via /lojaimagem)
function montarEmbedItem(itemId) {
  const item = LOJA_ITEMS[itemId];
  const embed = new EmbedBuilder()
    .setTitle(item.nome)
    .setDescription(`${item.descricao}\n\n**PREÇO:** ${formatarMoedas(item.preco)}`)
    .setColor(0x9b59b6)
    .setFooter({ text: "**Baguncinha Store**" });

  if (lojaImagens[itemId]) embed.setImage(lojaImagens[itemId]);
  return embed;
}

function montarComponentesItem(itemId) {
  const item = LOJA_ITEMS[itemId];
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`loja_comprar_${itemId}`)
        .setLabel(`COMPRAR — ${item.preco}🪙`)
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`loja_cat_${item.categoria}`)
        .setLabel("⬅️ Voltar")
        .setStyle(ButtonStyle.Secondary)
    )
  ];
}

// Confirmação de compra com a imagem do item
function responderCompra(interaction, item, itemId, texto) {
  const embed = new EmbedBuilder()
    .setTitle(item.nome)
    .setDescription(texto)
    .setColor(0x2ecc71);

  if (lojaImagens[itemId]) embed.setImage(lojaImagens[itemId]);
  return interaction.reply({ embeds: [embed], ephemeral: true });
}

async function comprarItem(interaction, itemId) {
  const item = LOJA_ITEMS[itemId];

  if (!item) {
    await interaction.reply({ content: "❌ Esse item não existe.", ephemeral: true });
    return;
  }

  const data = getUserData(interaction.user.id);

  if (item.tipo === "turbo_trabalhar" && data.turboTrabalhar) {
    await interaction.reply({ content: "❌ Você já tem o Turbo Trabalhar ativo.", ephemeral: true });
    return;
  }

  if (data.coins < item.preco) {
    await interaction.reply({
      content: `❌ Faltam ${formatarMoedas(item.preco - data.coins)} pra comprar **${item.nome}**.`,
      ephemeral: true
    });
    return;
  }

  data.coins -= item.preco;

  if (item.tipo === "caixa") {
    const recompensa = sortearRecompensaCaixa();
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    const descricaoPremio = await aplicarRecompensaCaixa(member, data, recompensa);

    const embed = new EmbedBuilder()
      .setTitle(`📦 ${item.nome} — ${recompensa.raridade}`)
      .setDescription(descricaoPremio)
      .setColor(CORES_RARIDADE[recompensa.raridade] || 0x9b59b6);

    if (lojaImagens[itemId]) embed.setImage(lojaImagens[itemId]);

    await verificarMarcosMoedas(interaction.guild, interaction.user.id, data);
    salvarDados();
    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  if (item.tipo === "ticket") {
    data.ticketsSorteio += 1;
    salvarDados();
    await responderCompra(
      interaction,
      item,
      itemId,
      `🎫 Você comprou 1 ticket de sorteio! Total: **${data.ticketsSorteio}**.`
    );
    return;
  }

  if (item.tipo === "turbo_trabalhar") {
    data.turboTrabalhar = true;
    salvarDados();
    await responderCompra(
      interaction,
      item,
      itemId,
      "✅ Comprado! Seu tempo do `/trabalhar` agora é de **25 minutos**."
    );
    return;
  }

  if (item.tipo === "xp_boost") {
    const agora = Date.now();
    data.xpBoostAte = Math.max(data.xpBoostAte, agora) + 60 * 60 * 1000;
    salvarDados();
    await responderCompra(interaction, item, itemId, "✅ **XP Boost 2x** ativado por 1 hora!");
    return;
  }

  if (item.tipo === "cargo") {
    if (item.roleId.startsWith("COLOQUE_")) {
      data.coins += item.preco;
      salvarDados();
      await interaction.reply({
        content: "❌ Esse cargo ainda não foi configurado pelo admin. Nada foi cobrado.",
        ephemeral: true
      });
      return;
    }

    try {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      await member.roles.add(item.roleId);
    } catch (error) {
      console.error("❌ Erro ao dar cargo da loja:", error);
    }

    salvarDados();
    await responderCompra(interaction, item, itemId, `✅ Você comprou **${item.nome}**! Aproveita.`);
    return;
  }
}

async function handleLojaInteraction(interaction) {
  // Escolheu uma categoria
  if (interaction.isStringSelectMenu() && interaction.customId === "loja_categoria") {
    const categoriaId = interaction.values[0];
    await interaction.update({
      embeds: [montarEmbedLojaCategoria(categoriaId)],
      components: montarComponentesLojaCategoria(categoriaId)
    });
    return;
  }

  // Escolheu um item -> mostra a prévia com imagem + botão de comprar
  if (interaction.isStringSelectMenu() && interaction.customId === "loja_item") {
    const itemId = interaction.values[0];
    if (!LOJA_ITEMS[itemId]) return;

    await interaction.update({
      embeds: [montarEmbedItem(itemId)],
      components: montarComponentesItem(itemId)
    });
    return;
  }

  // Voltar da prévia do item pra lista da categoria
  if (interaction.isButton() && interaction.customId.startsWith("loja_cat_")) {
    const categoriaId = interaction.customId.replace("loja_cat_", "");
    if (!LOJA_CATEGORIAS[categoriaId]) return;

    await interaction.update({
      embeds: [montarEmbedLojaCategoria(categoriaId)],
      components: montarComponentesLojaCategoria(categoriaId)
    });
    return;
  }

  // Voltar pras categorias
  if (interaction.isButton() && interaction.customId === "loja_voltar") {
    await interaction.update({
      embeds: [montarEmbedLojaPrincipal()],
      components: montarComponentesLojaPrincipal()
    });
    return;
  }

  // Comprar
  if (interaction.isButton() && interaction.customId.startsWith("loja_comprar_")) {
    const itemId = interaction.customId.replace("loja_comprar_", "");
    await comprarItem(interaction, itemId);
    return;
  }
}

// =========================
// PEDRA, PAPEL OU TESOURA (APOSTA ENTRE USUÁRIOS)
// =========================
const pptMatches = new Map(); // matchId -> { desafianteId, desafiadoId, aposta, status, escolhas }
const PPT_OPCOES = { pedra: "🪨 Pedra", papel: "📄 Papel", tesoura: "✂️ Tesoura" };

function resolverPpt(escolhaA, escolhaB) {
  if (escolhaA === escolhaB) return "empate";
  const vence = { pedra: "tesoura", papel: "pedra", tesoura: "papel" };
  return vence[escolhaA] === escolhaB ? "A" : "B";
}

async function handlePptInteraction(interaction) {
  const [, acao, matchId] = interaction.customId.split(":");
  const match = pptMatches.get(matchId);

  if (!match) {
    await interaction.reply({ content: "❌ Esse desafio expirou ou não existe mais.", ephemeral: true });
    return;
  }

  if (acao === "aceitar" || acao === "recusar") {
    if (interaction.user.id !== match.desafiadoId) {
      await interaction.reply({ content: "❌ Esse desafio não é seu.", ephemeral: true });
      return;
    }

    if (acao === "recusar") {
      pptMatches.delete(matchId);
      await interaction.update({
        content: `❌ ${interaction.user} recusou o desafio.`,
        embeds: [],
        components: []
      });
      return;
    }

    const desafianteData = getUserData(match.desafianteId);
    const desafiadoData = getUserData(match.desafiadoId);

    if (desafianteData.coins < match.aposta || desafiadoData.coins < match.aposta) {
      pptMatches.delete(matchId);
      await interaction.update({
        content: "❌ Alguém não tem mais moedas suficientes pra essa aposta. Desafio cancelado.",
        embeds: [],
        components: []
      });
      return;
    }

    desafianteData.coins -= match.aposta;
    desafiadoData.coins -= match.aposta;
    match.status = "jogando";

    const linhaEscolhas = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ppt:escolha_pedra:${matchId}`).setLabel("🪨 Pedra").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`ppt:escolha_papel:${matchId}`).setLabel("📄 Papel").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`ppt:escolha_tesoura:${matchId}`).setLabel("✂️ Tesoura").setStyle(ButtonStyle.Secondary)
    );

    salvarDados();
    await interaction.update({
      content: `✅ Desafio aceito! Aposta de ${formatarMoedas(match.aposta)} cada.\nCliquem na escolha de vocês (só você vê sua própria confirmação).`,
      embeds: [],
      components: [linhaEscolhas]
    });
    return;
  }

  if (acao.startsWith("escolha_")) {
    if (match.status !== "jogando") {
      await interaction.reply({ content: "❌ Esse desafio ainda não começou ou já acabou.", ephemeral: true });
      return;
    }

    if (interaction.user.id !== match.desafianteId && interaction.user.id !== match.desafiadoId) {
      await interaction.reply({ content: "❌ Esse desafio não é seu fi.", ephemeral: true });
      return;
    }

    if (match.escolhas[interaction.user.id]) {
      await interaction.reply({ content: "❌ Você já escolheu.", ephemeral: true });
      return;
    }

    const escolha = acao.replace("escolha_", "");
    match.escolhas[interaction.user.id] = escolha;

    await interaction.reply({
      content: `✅ Você escolheu ${PPT_OPCOES[escolha]}. Aguardando o adversário...`,
      ephemeral: true
    });

    const escolhaA = match.escolhas[match.desafianteId];
    const escolhaB = match.escolhas[match.desafiadoId];

    if (!escolhaA || !escolhaB) return;

    const desafianteData = getUserData(match.desafianteId);
    const desafiadoData = getUserData(match.desafiadoId);
    const resultado = resolverPpt(escolhaA, escolhaB);

    let textoResultado;
    if (resultado === "empate") {
      desafianteData.coins += match.aposta;
      desafiadoData.coins += match.aposta;
      textoResultado = `🤝 Empate! ${PPT_OPCOES[escolhaA]} x ${PPT_OPCOES[escolhaB]}. Moedas devolvidas pros dois.`;
    } else if (resultado === "A") {
      desafianteData.coins += match.aposta * 2;
      await verificarMarcosMoedas(interaction.guild, match.desafianteId, desafianteData);
      textoResultado = `🏆 <@${match.desafianteId}> venceu! ${PPT_OPCOES[escolhaA]} bate ${PPT_OPCOES[escolhaB]}. Levou ${formatarMoedas(match.aposta * 2)}.`;
    } else {
      desafiadoData.coins += match.aposta * 2;
      await verificarMarcosMoedas(interaction.guild, match.desafiadoId, desafiadoData);
      textoResultado = `🏆 <@${match.desafiadoId}> venceu! ${PPT_OPCOES[escolhaB]} bate ${PPT_OPCOES[escolhaA]}. Levou ${formatarMoedas(match.aposta * 2)}.`;
    }

    pptMatches.delete(matchId);
    salvarDados();

    await interaction.message.edit({
      content: `📢 Resultado do desafio\n${textoResultado}`,
      embeds: [],
      components: []
    }).catch(() => {});
    return;
  }
}

// =========================
// MINIGAME DE ROUBO ("arromba o cofre")
// =========================
// Antes o /roubar era só um sorteio de 40%. Agora o ladrão encara 3 fases de
// memória com sequências cada vez maiores e tempo curto. Passar em tudo libera
// um saque alto (% alta da carteira da vítima). Errar ou estourar o tempo =
// PRESO + multa de 40% do valor total da vítima.

// Monta as linhas de botões com os símbolos embaralhados (5 por linha).
function montarBotoesRoubo(matchId, ordemSimbolos) {
  const linhas = [];
  for (let inicio = 0; inicio < ordemSimbolos.length; inicio += 5) {
    const linha = new ActionRowBuilder();
    ordemSimbolos.slice(inicio, inicio + 5).forEach((simbolo, i) => {
      linha.addComponents(
        new ButtonBuilder()
          .setCustomId(`roubo:${matchId}:${inicio + i}`)
          .setEmoji(simbolo)
          .setStyle(ButtonStyle.Secondary)
      );
    });
    linhas.push(linha);
  }
  return linhas;
}

function esperarCollector(coletor) {
  return new Promise(resolve => {
    coletor.once("end", (_coletados, motivo) => resolve(motivo));
  });
}

async function resolverRouboSucesso(interaction, alvo, ladrao, vitima, mensagem) {
  const percentual = ROUBO_SAQUE_MIN + Math.random() * (ROUBO_SAQUE_MAX - ROUBO_SAQUE_MIN);
  const roubado = Math.max(1, Math.floor(vitima.coins * percentual));

  vitima.coins -= roubado;
  ladrao.coins += roubado;

  await verificarMarcosMoedas(interaction.guild, interaction.user.id, ladrao);
  salvarDados();

  const embed = new EmbedBuilder()
    .setTitle("🕵️ ASSALTO PERFEITO!")
    .setColor(0x27ae60)
    .setDescription(
      `<@${interaction.user.id}> arrombou o cofre e levou **${formatarMoedas(roubado)}** ` +
      `(${Math.round(percentual * 100)}% da carteira) de <@${alvo.id}>!\n` +
      `Agora a carteira da vítima tá com ${formatarMoedas(vitima.coins)}.`
    );

  await mensagem.edit({ content: "", embeds: [embed], components: [] }).catch(() => {});
}

async function resolverRouboFalha(interaction, alvo, ladrao, vitima, mensagem, motivo) {
  const multa = Math.floor(getTotalMoedas(vitima) * ROUBO_MULTA_PERCENTUAL);

  // O ladrão paga primeiro da carteira e depois do banco: o banco protege você
  // de ser roubado, mas não de pagar a multa quando VOCÊ é quem foi pego.
  let restante = multa;
  const daCarteira = Math.min(Math.max(0, ladrao.coins), restante);
  ladrao.coins -= daCarteira;
  restante -= daCarteira;
  const doBanco = Math.min(Math.max(0, ladrao.banco), restante);
  ladrao.banco -= doBanco;
  const pago = daCarteira + doBanco;

  vitima.coins += pago; // a vítima é ressarcida com a multa
  ladrao.presoAte = Date.now() + PRISAO_MS;

  await verificarMarcosMoedas(interaction.guild, alvo.id, vitima);
  salvarDados();

  const embed = new EmbedBuilder()
    .setTitle("🚨 PEGO NO FLAGRANTE!")
    .setColor(0xe74c3c)
    .setDescription(
      `<@${interaction.user.id}> foi pego (${motivo}) tentando roubar <@${alvo.id}>!\n\n` +
      `💸 Multa: **${formatarMoedas(multa)}** (40% do valor total da vítima)\n` +
      `Pagou: ${formatarMoedas(pago)}${pago < multa ? " — não tinha tudo e entregou o que dava" : ""}\n` +
      (pago > 0 ? `A vítima foi ressarcida com esse valor.\n` : "") +
      `O ladrão ficou **PRESO por 15 minutos** (nada de trabalhar, pescar ou roubar).`
    );

  await mensagem.edit({ content: "", embeds: [embed], components: [] }).catch(() => {});
}

async function iniciarRouboMinigame(interaction, alvo, ladrao, vitima) {
  const matchId = interaction.id;
  const ladraoId = interaction.user.id;

  await interaction.reply({
    content:
      `🕵️ **${interaction.user.username}** tá armando um assalto na carteira de **${alvo.username}**!\n` +
      `São 3 fases de memória: decore a sequência e clique na ordem certa. ` +
      `Se vacilar, paga **40% do valor total** da vítima e vai preso. Boa sorte.`,
    ephemeral: false
  });

  const mensagem = await interaction.fetchReply();
  const embed = new EmbedBuilder();

  for (let r = 0; r < ROUBO_RODADAS.length; r++) {
    const { tamanho, mostrarMs, jogarMs } = ROUBO_RODADAS[r];

    // sequência sorteada (pode repetir símbolo — fica mais difícil)
    const sequencia = Array.from(
      { length: tamanho },
      () => ROUBO_SIMBOLOS[Math.floor(Math.random() * ROUBO_SIMBOLOS.length)]
    );
    // os botões ficam numa ordem diferente da sequência, pra não entregar o jogo
    const ordemBotoes = [...ROUBO_SIMBOLOS].sort(() => Math.random() - 0.5);

    // 1) mostra a sequência por alguns segundos
    embed
      .setTitle(`🔓 Arrombando o cofre — Fase ${r + 1}/${ROUBO_RODADAS.length}`)
      .setColor(0x2c3e50)
      .setDescription(
        `**Decore a sequência!**\n\n${sequencia.join(" ")}\n\n` +
        `Ela some em ${(mostrarMs / 1000).toFixed(1)}s...`
      );
    await mensagem.edit({ content: "", embeds: [embed], components: [] }).catch(() => {});
    await esperar(mostrarMs);

    // 2) esconde a sequência e mostra os botões embaralhados
    const componentes = montarBotoesRoubo(matchId, ordemBotoes);
    embed
      .setTitle(`🔓 Arrombando o cofre — Fase ${r + 1}/${ROUBO_RODADAS.length}`)
      .setColor(0xe67e22)
      .setDescription(
        `Repita na **mesma ordem**! Cliques: 0/${tamanho}\n⏱️ ${Math.round(jogarMs / 1000)}s`
      );
    await mensagem.edit({ content: "", embeds: [embed], components: componentes }).catch(() => {});

    // 3) coleta os cliques e valida na ordem
    let posicao = 0;
    let erro = false;

    const coletor = mensagem.createMessageComponentCollector({
      filter: i => i.customId.startsWith(`roubo:${matchId}:`),
      time: jogarMs
    });

    coletor.on("collect", async i => {
      if (i.user.id !== ladraoId) {
        await i.reply({ content: "❌ Esse assalto não é seu, sai fora.", ephemeral: true }).catch(() => {});
        return;
      }

      if (erro || posicao >= sequencia.length) {
        await i.deferUpdate().catch(() => {});
        return;
      }

      const indice = Number(i.customId.split(":")[2]);
      const simbolo = ordemBotoes[indice];

      if (simbolo !== sequencia[posicao]) {
        erro = true;
        await i.deferUpdate().catch(() => {});
        coletor.stop("errou");
        return;
      }

      posicao++;
      await i.deferUpdate().catch(() => {});

      if (posicao >= sequencia.length) {
        coletor.stop("fase");
        return;
      }

      embed.setDescription(`Boa! Cliques: ${posicao}/${tamanho}\n⏱️ Continua...`);
      await mensagem.edit({ embeds: [embed], components: componentes }).catch(() => {});
    });

    const motivo = await esperarCollector(coletor);

    if (erro || motivo !== "fase") {
      const detalhe = erro ? "errou a sequência" : "deixou o tempo acabar";
      await resolverRouboFalha(interaction, alvo, ladrao, vitima, mensagem, detalhe);
      return;
    }
  }

  await resolverRouboSucesso(interaction, alvo, ladrao, vitima, mensagem);
}

// =========================
// COMANDOS
// =========================
const commands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Mostra a latência do bot."),

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Mostra os comandos disponíveis."),

  new SlashCommandBuilder()
    .setName("avatar")
    .setDescription("Mostra o avatar de um usuário.")
    .addUserOption(option =>
      option
        .setName("usuario")
        .setDescription("Usuário para ver o avatar (padrão: você mesmo)")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("userinfo")
    .setDescription("Mostra informações de um membro do servidor.")
    .addUserOption(option =>
      option
        .setName("usuario")
        .setDescription("Usuário para ver as informações (padrão: você mesmo)")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("serverinfo")
    .setDescription("Mostra informações sobre o servidor."),

  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Apaga uma quantidade de mensagens do canal.")
    .addIntegerOption(option =>
      option
        .setName("quantidade")
        .setDescription("Número de mensagens para apagar (1-100)")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(100)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName("lembrete")
    .setDescription("Cria um lembrete.")
    .addIntegerOption(option =>
      option
        .setName("minutos")
        .setDescription("Em quantos minutos te avisar?")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(1440)
    )
    .addStringOption(option =>
      option
        .setName("mensagem")
        .setDescription("O que você quer ser lembrado?")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("perfil")
    .setDescription("Mostra seu nível e XP no servidor.")
    .addUserOption(option =>
      option
        .setName("usuario")
        .setDescription("Usuário para ver o perfil (padrão: você mesmo)")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("rank")
    .setDescription("Mostra o ranking de XP do servidor (top 10)."),

  new SlashCommandBuilder()
    .setName("rankmoedas")
    .setDescription("Mostra o ranking de quem tem mais moedas no servidor (top 10)."),

  new SlashCommandBuilder()
    .setName("embed")
    .setDescription("Abre um construtor interativo de embed (staff).")
    .addStringOption(option =>
      option.setName("titulo").setDescription("Título do embed").setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("descricao")
        .setDescription("Texto do embed (use \\n pra quebrar linha)")
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName("carteira")
    .setDescription("Mostra quantas moedas você (ou alguém) tem.")
    .addUserOption(option =>
      option.setName("usuario").setDescription("Usuário para ver a carteira").setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("banco")
    .setDescription("Guarda suas moedas no banco — dinheiro no banco fica protegido de roubos.")
    .addStringOption(option =>
      option
        .setName("acao")
        .setDescription("O que você quer fazer no banco")
        .setRequired(false)
        .addChoices(
          { name: "Ver saldo", value: "ver" },
          { name: "Depositar", value: "depositar" },
          { name: "Sacar", value: "sacar" },
          { name: "Depositar tudo", value: "depositar_tudo" },
          { name: "Sacar tudo", value: "sacar_tudo" }
        )
    )
    .addIntegerOption(option =>
      option
        .setName("quantidade")
        .setDescription("Quantidade (para depositar/sacar)")
        .setRequired(false)
        .setMinValue(1)
    ),

  new SlashCommandBuilder()
    .setName("daily")
    .setDescription("Resgata sua recompensa diária (250 a 500 moedas)."),

  new SlashCommandBuilder()
    .setName("trabalhar")
    .setDescription("Faz um trampo e ganha uma moedinha certa."),

  new SlashCommandBuilder()
    .setName("pescar")
    .setDescription("Vai pescar e pode voltar com uma grana (ou não)."),

  new SlashCommandBuilder()
    .setName("roubar")
    .setDescription("Tenta roubar a carteira de alguém num minigame. Se for pego, paga 40% do valor da vítima.")
    .addUserOption(option =>
      option.setName("usuario").setDescription("Quem você vai tentar roubar").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("doar")
    .setDescription("Doa uma quantidade de moedas pra outra pessoa.")
    .addUserOption(option =>
      option.setName("usuario").setDescription("Quem vai receber as moedas").setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName("quantidade")
        .setDescription("Quantas moedas você quer doar")
        .setRequired(true)
        .setMinValue(1)
    ),

  new SlashCommandBuilder()
    .setName("loja")
    .setDescription("Abre a Baguncinha Store em embed com botões pra comprar."),

  new SlashCommandBuilder()
    .setName("comprar")
    .setDescription("Compra um item da loja direto por comando.")
    .addStringOption(option =>
      option
        .setName("item")
        .setDescription("Item que você quer comprar")
        .setRequired(true)
        .addChoices(
          ...Object.entries(LOJA_ITEMS).map(([id, item]) => ({
            name: `${item.nome} (${item.preco} 🪙)`,
            value: id
          }))
        )
    ),

  new SlashCommandBuilder()
    .setName("lojaimagem")
    .setDescription("Define ou remove a imagem de um item da loja (só o dono).")
    .addStringOption(option =>
      option
        .setName("item")
        .setDescription("Item da loja")
        .setRequired(true)
        .addChoices(
          ...Object.entries(LOJA_ITEMS).map(([id, item]) => ({
            name: item.nome.slice(0, 100),
            value: id
          }))
        )
    )
    .addStringOption(option =>
      option
        .setName("url")
        .setDescription("URL da imagem (deixe vazio pra remover)")
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("apostar")
    .setDescription("Aposta suas moedas em cara ou coroa.")
    .addIntegerOption(option =>
      option
        .setName("quantidade")
        .setDescription("Quantas moedas você quer apostar?")
        .setRequired(true)
        .setMinValue(10)
    )
    .addStringOption(option =>
      option
        .setName("escolha")
        .setDescription("Cara ou coroa")
        .setRequired(true)
        .addChoices(
          { name: "Cara", value: "cara" },
          { name: "Coroa", value: "coroa" }
        )
    ),

  new SlashCommandBuilder()
    .setName("roleta")
    .setDescription("Aposta moedas na Roleta Baguncinha.")
    .addIntegerOption(option =>
      option
        .setName("quantidade")
        .setDescription(`Quanto apostar (${ROLETA_APOSTA_MIN} a ${ROLETA_APOSTA_MAX})`)
        .setRequired(true)
        .setMinValue(ROLETA_APOSTA_MIN)
        .setMaxValue(ROLETA_APOSTA_MAX)
    ),

  new SlashCommandBuilder()
    .setName("ppt")
    .setDescription("Desafia alguém pra Pedra, Papel ou Tesoura apostando moedas.")
    .addUserOption(option =>
      option.setName("usuario").setDescription("Quem você desafia").setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName("quantidade")
        .setDescription(`Quanto apostar (${PPT_APOSTA_MIN} a ${PPT_APOSTA_MAX})`)
        .setRequired(true)
        .setMinValue(PPT_APOSTA_MIN)
        .setMaxValue(PPT_APOSTA_MAX)
    ),

  new SlashCommandBuilder()
    .setName("conquistas")
    .setDescription("Vê e reivindica suas conquistas do servido."),

  new SlashCommandBuilder()
    .setName("jogos")
    .setDescription("Mostra os próximos jogos do Brasileirão, Libertadores e da Seleção."),

  new SlashCommandBuilder()
    .setName("editarmoedas")
    .setDescription("Adiciona, remove ou define as moedas de um usuário (admin).")
    .addUserOption(option =>
      option.setName("usuario").setDescription("Quem vai ter as moedas alteradas").setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("acao")
        .setDescription("O que fazer com as moedas")
        .setRequired(true)
        .addChoices(
          { name: "Adicionar", value: "adicionar" },
          { name: "Remover", value: "remover" },
          { name: "Definir (zera e coloca esse valor)", value: "definir" }
        )
    )
    .addIntegerOption(option =>
      option
        .setName("quantidade")
        .setDescription("Quantidade de moedas")
        .setRequired(true)
        .setMinValue(0)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("sortear")
    .setDescription("Sorteia um ganhador entre quem tem ticket de sorteio (staff).")
    .addStringOption(option =>
      option
        .setName("premio")
        .setDescription("O que está sendo sorteado (opcional)")
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName("bloquearcanais")
    .setDescription("Bloqueia a visão de todos os canais pro cargo Não Verificado (roda uma vez, admin).")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new ContextMenuCommandBuilder()
    .setName("Editar embed")
    .setType(ApplicationCommandType.Message)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)

].map(command => command.toJSON());

// =========================
// REGISTRO DOS COMANDOS
// =========================
async function registerCommands() {
  try {
    console.log("🔄 Registrando comandos no servidor...");

    const rest = new REST({
      version: "10"
    }).setToken(TOKEN);

    await rest.put(
      Routes.applicationGuildCommands(
        CLIENT_ID,
        GUILD_ID
      ),
      {
        body: commands
      }
    );

    console.log("✅ Comandos registrados no servidor!");
  } catch (error) {
    console.error("❌ Erro ao registrar comandos:");
    console.error(error);
  }
}

// =========================
// AVISOS DE FUTEBOL (BRASILEIRÃO + SELEÇÃO)
// =========================
// Fonte: TheSportsDB (gratuita, sem cadastro). Docs: https://www.thesportsdb.com/api.php
// A chave de teste "3" já funciona. Quem tiver Patreon pode colocar THESPORTSDB_KEY no Render.
//
// APIs avaliadas:
//   TheSportsDB          — grátis, sem chave, cobre Brasil. USADA.
//   football-data.org    — grátis com cadastro, mas Série A/Copa do Brasil pedem plano pago.
//   API-Football         — 100 req/dia com chave; o bot antigo dependia só disso e parava sem a chave.
//   ESPN site.api        — sem chave, mas bloqueia este ambiente (403).
const SPORTSDB_API_BASE = `https://www.thesportsdb.com/api/v1/json/${THESPORTSDB_KEY}`;

const LIGAS_FUTEBOL = [
  { id: "4351", nome: "Brasileirão Série A" },
  { id: "4404", nome: "Brasileirão Série B" },
  { id: "4725", nome: "Copa do Brasil" },
  { id: "4501", nome: "Copa Libertadores" }
];
const SELECAO_TEAM_ID = "134496";

let futebolChannelId = null;
const FOOTBALL_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const FOOTBALL_REMINDER_WINDOW_MIN = 90;
const FOOTBALL_RESULTADO_MAX_MS = 18 * 60 * 60 * 1000;
const avisosEnviados = new Set();
const resultadosEnviados = new Set();

let jogosCache = { timestamp: 0, dados: null };
const JOGOS_CACHE_MS = 10 * 60 * 1000;
let eventosFutebolCache = { timestamp: 0, dados: [] };
const EVENTOS_CACHE_MS = 8 * 60 * 1000;

function esperar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sportsDbFetch(endpoint, params) {
  const url = new URL(`${SPORTSDB_API_BASE}${endpoint}`);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "bot-baguncinha"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`TheSportsDB respondeu ${response.status}`);
    }

    const texto = await response.text();
    if (!texto) return {};
    return JSON.parse(texto);
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Tempo esgotado conectando na TheSportsDB (12s)");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseKickoffMs(evento) {
  if (evento.strTimestamp) {
    const bruto = String(evento.strTimestamp).trim().replace(" ", "T");
    const comZona = /Z$|[+-]\d{2}:?\d{2}$/.test(bruto) ? bruto : `${bruto}Z`;
    const t = Date.parse(comZona);
    if (!Number.isNaN(t)) return t;
  }

  if (evento.dateEvent && evento.strTime && evento.strTime !== "00:00:00") {
    const t = Date.parse(`${evento.dateEvent}T${evento.strTime}Z`);
    if (!Number.isNaN(t)) return t;
  }

  if (evento.dateEvent) {
    const t = Date.parse(`${evento.dateEvent}T15:00:00-03:00`);
    if (!Number.isNaN(t)) return t;
  }

  return 0;
}

function normalizarStatusFutebol(status) {
  const s = String(status || "").trim().toUpperCase();
  if (!s || s === "NS" || s === "NOT STARTED" || s === "TIMED" || s === "TBD") return "NS";
  if (["FT", "AET", "PEN", "FINISHED", "MATCH FINISHED", "AOT", "AP"].includes(s)) return "FT";
  if (["PST", "POSTPONED", "CANC", "CANCELLED", "ABD", "SUSP"].includes(s)) return "OFF";
  if (["1H", "2H", "HT", "ET", "P", "LIVE", "IN PLAY", "INT"].includes(s)) return "LIVE";
  return s;
}

function nomeMandante(evento) {
  return evento.strHomeTeam || "Mandante";
}

function nomeVisitante(evento) {
  return evento.strAwayTeam || "Visitante";
}

function nomeCompeticao(evento) {
  return evento.strLeague || "Futebol";
}

function formatarHorarioJogo(kickoffMs) {
  if (!kickoffMs) return "horário indefinido";
  const timestamp = Math.floor(kickoffMs / 1000);
  return `<t:${timestamp}:F> (<t:${timestamp}:R>)`;
}

function deduplicarEventos(lista) {
  const vistos = new Set();
  const unicos = [];
  for (const evento of lista) {
    const id = String(evento.idEvent || `${evento.strEvent}-${evento.dateEvent}`);
    if (vistos.has(id)) continue;
    vistos.add(id);
    unicos.push(evento);
  }
  return unicos;
}

async function coletarEventosFutebol() {
  if (eventosFutebolCache.dados.length && Date.now() - eventosFutebolCache.timestamp < EVENTOS_CACHE_MS) {
    return eventosFutebolCache.dados;
  }

  const eventos = [];
  const chamadas = [];

  for (const liga of LIGAS_FUTEBOL) {
    chamadas.push({ tipo: "liga-next", id: liga.id });
    chamadas.push({ tipo: "liga-past", id: liga.id });
  }
  chamadas.push({ tipo: "selecao-next" });
  chamadas.push({ tipo: "selecao-last" });

  for (const chamada of chamadas) {
    try {
      let lote = [];
      if (chamada.tipo === "liga-next") {
        const data = await sportsDbFetch("/eventsnextleague.php", { id: chamada.id });
        lote = data?.events || [];
      } else if (chamada.tipo === "liga-past") {
        const data = await sportsDbFetch("/eventspastleague.php", { id: chamada.id });
        lote = data?.events || [];
      } else if (chamada.tipo === "selecao-next") {
        const data = await sportsDbFetch("/eventsnext.php", { id: SELECAO_TEAM_ID });
        lote = data?.events || [];
      } else if (chamada.tipo === "selecao-last") {
        const data = await sportsDbFetch("/eventslast.php", { id: SELECAO_TEAM_ID });
        lote = data?.results || data?.events || [];
      }
      eventos.push(...lote);
    } catch (error) {
      console.error(`❌ Falha ao buscar jogos (${chamada.tipo} ${chamada.id || "selecao"}):`, error.message);
    }
    await esperar(250);
  }

  const unicos = deduplicarEventos(eventos);
  eventosFutebolCache = { timestamp: Date.now(), dados: unicos };
  return unicos;
}

function normalizarNomeCanal(nome) {
  return String(nome || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

async function acharCanalPorNome(guild, nomesAlvo) {
  if (!guild) return null;

  await guild.channels.fetch().catch(() => {});

  const alvos = nomesAlvo.map(normalizarNomeCanal);
  const candidatos = [...guild.channels.cache.values()].filter(c => {
    if (c.type !== ChannelType.GuildText && c.type !== ChannelType.GuildAnnouncement) return false;
    return alvos.includes(normalizarNomeCanal(c.name));
  });

  if (candidatos.length === 0) return null;

  candidatos.sort((a, b) => (a.createdTimestamp || 0) - (b.createdTimestamp || 0));
  return candidatos[0];
}

async function ensureFutebolChannel(guild) {
  let channel = await acharCanalPorNome(guild, ["futebol", "football"]);

  if (!channel) {
    try {
      channel = await guild.channels.create({
        name: "futebol",
        type: ChannelType.GuildText,
        topic: "Avisos automáticos do Brasileirão, Libertadores e da Seleção Brasileira"
      });
      console.log("✅ Canal #futebol criado.");
    } catch (error) {
      console.error("❌ Não consegui criar o canal #futebol (confere a permissão 'Gerenciar Canais' do bot):");
      console.error(error);
      return null;
    }
  }

  return channel;
}

async function checkFootball() {
  if (!futebolChannelId) return;

  const channel = client.channels.cache.get(futebolChannelId);
  if (!channel) return;

  try {
    const fixtures = await coletarEventosFutebol();
    const now = Date.now();

    for (const jogo of fixtures) {
      const fixtureId = String(jogo.idEvent || "");
      if (!fixtureId) continue;

      const status = normalizarStatusFutebol(jogo.strStatus);
      const kickoff = parseKickoffMs(jogo);
      const minutosParaComecar = kickoff ? (kickoff - now) / 60000 : Infinity;
      const mandante = nomeMandante(jogo);
      const visitante = nomeVisitante(jogo);
      const competicao = nomeCompeticao(jogo);

      if (
        status === "NS" &&
        minutosParaComecar > 0 &&
        minutosParaComecar <= FOOTBALL_REMINDER_WINDOW_MIN &&
        !avisosEnviados.has(fixtureId)
      ) {
        avisosEnviados.add(fixtureId);

        const embed = new EmbedBuilder()
          .setTitle(`⚽ ${mandante} x ${visitante}`)
          .setDescription(
            `Partida chegando, cria! Se liga:\n\n` +
            `🏆 ${competicao}\n` +
            `🕐 ${formatarHorarioJogo(kickoff)}`
          )
          .setColor(0x2ecc71);

        channel.send({ embeds: [embed] }).catch(() => {});
      }

      const acabouHaPouco = kickoff && now - kickoff >= 0 && now - kickoff <= FOOTBALL_RESULTADO_MAX_MS;
      if (status === "FT" && acabouHaPouco && !resultadosEnviados.has(fixtureId)) {
        resultadosEnviados.add(fixtureId);

        const golsMandante = jogo.intHomeScore ?? "?";
        const golsVisitante = jogo.intAwayScore ?? "?";

        const embed = new EmbedBuilder()
          .setTitle(`🏁 Acabou o jogo — ${mandante} ${golsMandante} x ${golsVisitante} ${visitante}`)
          .setDescription(`🏆 ${competicao}`)
          .setColor(0xe67e22);

        channel.send({ embeds: [embed] }).catch(() => {});
      }
    }
  } catch (error) {
    console.error("❌ Erro ao checar jogos de futebol:", error.message);
  }
}

// =========================
// BOT CONECTADO
// =========================
client.once("ready", async () => {
  console.log("=================================");
  console.log(`🤖 Bot conectado como ${client.user.tag}`);
  console.log(`🆔 ID: ${client.user.id}`);
  console.log(`🌐 Servidores: ${client.guilds.cache.size}`);
  console.log("=================================");

  setInterval(tickVoiceXp, VOICE_XP_INTERVAL_MS);
  console.log(`🎙️ Rastreamento de XP por voz ativado (a cada ${VOICE_XP_INTERVAL_MS / 60000} min)`);

  const guildVerificacao = client.guilds.cache.get(GUILD_ID);
  if (guildVerificacao && !NAO_VERIFICADO_ROLE_ID.startsWith("COLOQUE_")) {
    await ensureInterestRoles(guildVerificacao);
    await ensureTop1Role(guildVerificacao);
    await atualizarTop1(guildVerificacao);
    const canalVerificacao = await ensureVerificacaoChannel(guildVerificacao);
    if (canalVerificacao) {
      const mensagem = await ensureVerificacaoMessage(canalVerificacao);
      if (mensagem) {
        verificacaoMessageId = mensagem.id;
        console.log(`Sistema de verificacao ativo (mensagem ${verificacaoMessageId}).`);
      } else {
        console.log("Verificacao NAO ativa: nao consegui criar/achar a mensagem de verificacao.");
      }
    } else {
      console.log("Verificacao NAO ativa: nao consegui criar/achar o canal #verificacao.");
    }
  } else {
    console.log("NAO_VERIFICADO_ROLE_ID nao configurado — verificacao desativada.");
  }

  setInterval(() => {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (guild) atualizarTop1(guild).catch(() => {});
  }, 60 * 60 * 1000);

  const guildFutebol = client.guilds.cache.get(GUILD_ID);
  if (guildFutebol) {
    const canal = await ensureFutebolChannel(guildFutebol);
    if (canal) futebolChannelId = canal.id;
  }

  if (futebolChannelId) {
    setInterval(checkFootball, FOOTBALL_CHECK_INTERVAL_MS);
    checkFootball();
    console.log(`⚽ Avisos de futebol ativados (a cada ${FOOTBALL_CHECK_INTERVAL_MS / 60000} min, TheSportsDB)`);
  } else {
    console.log("⚠️ Canal #futebol não disponível — avisos de futebol desativados.");
  }
});

// =========================
// VERIFICACAO POR BOTOES — PORTAO DE ENTRADA
// =========================
// Novo membro ganha o cargo "Nao Verificado" e so enxerga o canal de verificacao.
// Quando clica num botao de interesse, ganha o cargo e perde o "Nao Verificado".
const NAO_VERIFICADO_ROLE_ID = "1552496115566252082";

const INTEREST_BOTOES = [
  { id: "valorant", label: "Valorant", emoji: "🎯" },
  { id: "minecraft", label: "Minecraft", emoji: "⛏️" },
  { id: "cs", label: "CS", emoji: "🔫" },
  { id: "roblox", label: "Roblox", emoji: "🧱" },
  { id: "fortnite", label: "Fortnite", emoji: "🪂" },
  { id: "futebol", label: "Futebol", emoji: "⚽" },
  { id: "nitros", label: "Nitros", emoji: "💎" },
  { id: "promocao", label: "Promocoes", emoji: "🏷️" },
  { id: "geral", label: "Geral", emoji: "💬" }
];

const VERIFICACAO_MARCADOR = "verificacao-baguncinha";
const VERIFICACAO_BTN_PREFIX = "verificacao:";
let verificacaoMessageId = null;

function montarEmbedVerificacao() {
  const lista = INTEREST_BOTOES
    .map(b => `• ${(NOMES_INTERESSES[b.id] || b.label).replace(/^[^\p{L}\p{N}]+/u, "").trim()}`)
    .join("\n");

  return new EmbedBuilder()
    .setTitle("Verificacao de acesso")
    .setDescription(
      "Bem-vindo(a) a Baguncinha! Pra liberar o acesso ao resto do servidor, clica no botao " +
      "do que voce curte:\n\n" +
      `${lista}\n\n` +
      "Assim que clicar em pelo menos um, seu acesso ja e liberado na hora."
    )
    .setColor(0x5865f2)
    .setFooter({ text: VERIFICACAO_MARCADOR });
}

function montarBotoesVerificacao() {
  const rows = [];
  for (let i = 0; i < INTEREST_BOTOES.length; i += 5) {
    const chunk = INTEREST_BOTOES.slice(i, i + 5);
    const row = new ActionRowBuilder();
    for (const botao of chunk) {
      const b = new ButtonBuilder()
        .setCustomId(`${VERIFICACAO_BTN_PREFIX}${botao.id}`)
        .setLabel(botao.label)
        .setStyle(ButtonStyle.Primary);
      if (botao.emoji) b.setEmoji(botao.emoji);
      row.addComponents(b);
    }
    rows.push(row);
  }
  return rows;
}

function ehMensagemVerificacao(mensagem) {
  if (!client.user || mensagem.author?.id !== client.user.id) return false;
  const embed = mensagem.embeds[0];
  if (!embed) return false;
  if (embed.footer?.text === VERIFICACAO_MARCADOR) return true;
  const titulo = String(embed.title || "");
  return titulo.includes("Verificação") || titulo.includes("Verificacao");
}

async function ensureVerificacaoChannel(guild) {
  let channel = await acharCanalPorNome(guild, ["verificacao", "verificação"]);

  if (!channel) {
    try {
      channel = await guild.channels.create({
        name: "verificacao",
        type: ChannelType.GuildText,
        topic: "Clique nos botoes pra liberar seu acesso ao servidor"
      });
      console.log("✅ Canal #verificacao criado.");
    } catch (error) {
      console.error("❌ Não consegui criar o canal #verificacao (confere a permissão 'Gerenciar Canais'):");
      console.error(error);
      return null;
    }
  }

  return channel;
}

async function ensureVerificacaoMessage(channel) {
  try {
    const mensagens = await channel.messages.fetch({ limit: 100 });
    const existentes = [...mensagens.values()]
      .filter(ehMensagemVerificacao)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    const embed = montarEmbedVerificacao();
    const components = montarBotoesVerificacao();
    const existente = existentes[0];

    if (existente) {
      await existente.edit({ embeds: [embed], components }).catch(() => {});
      await existente.reactions.removeAll().catch(() => {});
      return existente;
    }

    const mensagem = await channel.send({ embeds: [embed], components });
    return mensagem;
  } catch (error) {
    console.error("❌ Erro ao preparar mensagem de verificação:", error);
    return null;
  }
}

client.on("guildMemberAdd", async member => {
  if (member.user.bot) return;
  if (NAO_VERIFICADO_ROLE_ID.startsWith("COLOQUE_")) return; // ainda não configurado

  try {
    await member.roles.add(NAO_VERIFICADO_ROLE_ID);
    console.log(`🔒 ${member.user.tag} marcado como não verificado.`);
  } catch (error) {
    console.error("❌ Erro ao dar cargo de não verificado:", error);
  }
});

async function handleVerificacaoBotao(interaction) {
  const interesse = interaction.customId.slice(VERIFICACAO_BTN_PREFIX.length);
  const valido = INTEREST_BOTOES.some(b => b.id === interesse);
  if (!valido) {
    await interaction.reply({ content: "Esse botao nao e valido.", ephemeral: true }).catch(() => {});
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) {
    await interaction.reply({ content: "Nao consegui te achar no servidor.", ephemeral: true }).catch(() => {});
    return;
  }

  const roleId = INTEREST_ROLES[interesse];
  let ganhouCargo = false;
  let jaTinhaCargo = false;

  if (roleId && !String(roleId).startsWith("COLOQUE_")) {
    jaTinhaCargo = member.roles.cache.has(roleId);
    if (!jaTinhaCargo) {
      await member.roles.add(roleId).catch(() => {});
      ganhouCargo = true;
    } else {
      await member.roles.remove(roleId).catch(() => {});
    }
  }

  let acabouDeVerificar = false;
  if (!NAO_VERIFICADO_ROLE_ID.startsWith("COLOQUE_") && member.roles.cache.has(NAO_VERIFICADO_ROLE_ID)) {
    await member.roles.remove(NAO_VERIFICADO_ROLE_ID).catch(() => {});
    acabouDeVerificar = true;
    console.log(`${interaction.user.tag} verificado.`);
  }

  const nomeInteresse = (NOMES_INTERESSES[interesse] || interesse).replace(/^[^\p{L}\p{N}]+/u, "").trim();
  let texto;
  if (acabouDeVerificar) {
    texto = `Verificado! Acesso liberado. Cargo **${nomeInteresse}** adicionado.`;
  } else if (ganhouCargo) {
    texto = `Cargo **${nomeInteresse}** adicionado.`;
  } else if (jaTinhaCargo) {
    texto = `Cargo **${nomeInteresse}** removido.`;
  } else {
    texto = `Verificado! Acesso liberado.`;
  }

  await interaction.reply({ content: texto, ephemeral: true }).catch(() => {});
}

// =========================
// GANHO DE XP POR MENSAGEM
// =========================
const XP_COOLDOWN_MS = 60 * 1000; // 1 minuto entre ganhos de XP por usuário

client.on("messageCreate", async message => {
  if (message.author.bot || !message.guild) return;

  const data = getUserData(message.author.id);
  const now = Date.now();

  if (now - data.lastMessageTimestamp < XP_COOLDOWN_MS) return;

  data.lastMessageTimestamp = now;
  const xpGained = Math.floor(Math.random() * 10) + 5; // 5 a 14 XP por mensagem
  const { leveledUp, data: updated } = addXp(message.author.id, xpGained, "text");

  if (leveledUp) {
    message.channel
      .send(`💬 Salve ${message.author}, você subiu pro **nível de texto ${updated.textLevel}**!`)
      .catch(() => {});

    const newRoleId = await updateLevelRole(message.guild, message.author.id, getTotalLevel(updated));
    if (newRoleId) {
      message.channel
        .send(`🏅 ${message.author} desbloqueou o cargo <@&${newRoleId}> na correria!`)
        .catch(() => {});
    }
  }
});

// =========================
// GANHO DE XP POR VOZ (CALL)
// =========================
// A cada X minutos, todo mundo que está conectado em um canal de voz
// (menos o canal AFK e bots) ganha XP de voz. É separado do XP de texto.
const VOICE_XP_INTERVAL_MS = 5 * 60 * 1000; // a cada 5 minutos

async function tickVoiceXp() {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;

  const voiceChannels = guild.channels.cache.filter(
    channel => channel.type === ChannelType.GuildVoice && channel.id !== guild.afkChannelId
  );

  for (const channel of voiceChannels.values()) {
    for (const member of channel.members.values()) {
      if (member.user.bot) continue;

      const xpGained = Math.floor(Math.random() * 10) + 15; // 15 a 24 XP a cada 5 min
      const { leveledUp, data: updated } = addXp(member.id, xpGained, "voice");

      if (leveledUp) {
        const announceChannel = guild.systemChannel;
        if (announceChannel) {
          announceChannel
            .send(`🎙️ Salve ${member}, você subiu pro **nível de voz ${updated.voiceLevel}**!`)
            .catch(() => {});
        }

        const newRoleId = await updateLevelRole(guild, member.id, getTotalLevel(updated));
        if (newRoleId && announceChannel) {
          announceChannel
            .send(`🏅 ${member} desbloqueou o cargo <@&${newRoleId}> na correria!`)
            .catch(() => {});
        }
      }
    }
  }
}

// =========================
// CONSTRUTOR INTERATIVO DE /embed
// =========================
const embedDrafts = new Map(); // userId -> rascunho do embed em edição

const CORES_EMBED = {
  azul: { nome: "🔵 Azul", valor: 0x5865f2 },
  vermelho: { nome: "🔴 Vermelho", valor: 0xed4245 },
  verde: { nome: "🟢 Verde", valor: 0x57f287 },
  amarelo: { nome: "🟡 Amarelo", valor: 0xfee75c },
  roxo: { nome: "🟣 Roxo", valor: 0x9b59b6 },
  laranja: { nome: "🟠 Laranja", valor: 0xe67e22 },
  preto: { nome: "⚫ Preto", valor: 0x23272a },
  branco: { nome: "⚪ Branco", valor: 0xffffff },
  rosa: { nome: "🌸 Rosa", valor: 0xeb459e },
  aleatoria: { nome: "🎲 Aleatória (sorteia toda vez)", valor: null }
};

function urlValida(valor) {
  return typeof valor === "string" && /^https?:\/\//i.test(valor);
}

// =========================
// BOTÕES DO EMBED (o que cada botão faz)
// =========================
// Tipos: "link" (abre um site), "cargo" (dá/tira um cargo), "msg" (responde uma mensagem só pra quem clicou).
// Máximo de 5 botões por embed (uma linha). O texto da resposta do tipo "msg" vai dentro do
// próprio botão (customId), por isso o limite de 70 caracteres — assim funciona pra sempre,
// mesmo depois de reiniciar o bot.
const EMBED_BOTOES_MAX = 5;
const EMBED_BOTAO_MSG_MAX = 70;

// Cargos com essas permissões NUNCA podem virar botão — senão qualquer pessoa
// clicando ganharia poder de staff.
const PERMISSOES_PERIGOSAS_BOTAO = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.MentionEveryone
];

// Retorna o motivo do erro (texto) ou null se o cargo pode ser usado.
// memberCriador = quem está montando o embed (null na hora do clique).
function validarCargoParaBotao(guild, role, memberCriador) {
  if (!role) return "Não achei esse cargo.";
  if (role.id === guild.id) return "Não dá pra usar o @everyone.";
  if (role.managed) return "Esse cargo é de um bot/integração.";
  if (role.id === NAO_VERIFICADO_ROLE_ID) return "Esse é o cargo da verificação, não pode virar botão.";
  if (role.permissions.any(PERMISSOES_PERIGOSAS_BOTAO)) {
    return "Esse cargo tem permissão de staff/administração, então não pode ser dado por botão.";
  }
  if (!role.editable) return "Meu cargo precisa estar ACIMA desse cargo na lista de cargos.";
  if (
    memberCriador &&
    guild.ownerId !== memberCriador.id &&
    memberCriador.roles.highest.comparePositionTo(role) <= 0
  ) {
    return "Você só pode usar cargos que estão abaixo do seu cargo mais alto.";
  }
  return null;
}

// Aceita ID, menção (<@&id>) ou nome do cargo
function acharCargoPorTexto(guild, texto) {
  const limpo = texto.trim();
  const idMatch = limpo.match(/^<@&(\d+)>$/) || limpo.match(/^(\d{15,25})$/);
  if (idMatch) return guild.roles.cache.get(idMatch[1]) || null;

  const minusculo = limpo.toLowerCase();
  return guild.roles.cache.find(r => r.name.toLowerCase() === minusculo) || null;
}

function customIdDoBotao(botao) {
  if (botao.tipo === "cargo") return `embedbtn:cargo:${botao.roleId}`;
  if (botao.tipo === "msg") return `embedbtn:msg:${botao.texto}`;
  return null;
}

function montarBotoesPublicos(botoes) {
  if (!botoes || botoes.length === 0) return [];

  const linha = new ActionRowBuilder();
  for (const botao of botoes) {
    const b = new ButtonBuilder().setLabel(botao.label);

    if (botao.tipo === "link") {
      b.setStyle(ButtonStyle.Link).setURL(botao.url);
    } else if (botao.tipo === "cargo") {
      b.setStyle(ButtonStyle.Success).setCustomId(customIdDoBotao(botao));
    } else {
      b.setStyle(ButtonStyle.Primary).setCustomId(customIdDoBotao(botao));
    }

    linha.addComponents(b);
  }

  return [linha];
}

function descreverBotao(botao, indice) {
  if (botao.tipo === "link") return `${indice + 1}. 🔗 **${botao.label}** → abre ${botao.url}`;
  if (botao.tipo === "cargo") return `${indice + 1}. 🎭 **${botao.label}** → dá/tira o cargo <@&${botao.roleId}>`;
  return `${indice + 1}. 💬 **${botao.label}** → responde: "${botao.texto}"`;
}

function botoesFromMensagem(mensagem) {
  const botoes = [];
  for (const row of mensagem.components || []) {
    for (const comp of row.components || []) {
      const label = comp.label || "Botão";
      const customId = comp.customId || "";
      if (comp.style === ButtonStyle.Link && comp.url) {
        botoes.push({ tipo: "link", label, url: comp.url });
      } else if (customId.startsWith("embedbtn:cargo:")) {
        botoes.push({ tipo: "cargo", label, roleId: customId.slice("embedbtn:cargo:".length) });
      } else if (customId.startsWith("embedbtn:msg:")) {
        botoes.push({ tipo: "msg", label, texto: customId.slice("embedbtn:msg:".length) });
      }
    }
  }
  return botoes.slice(0, EMBED_BOTOES_MAX);
}

function draftFromMensagem(mensagem, autorNome) {
  const embed = mensagem.embeds[0];
  return {
    titulo: embed.title || "Sem título",
    descricao: embed.description || " ",
    cor: Number.isInteger(embed.color) ? embed.color : 0x5865f2,
    imagemUrl: embed.image?.url || null,
    footer: embed.footer?.text || null,
    linkTitulo: embed.url || null,
    canalId: mensagem.channelId,
    botoes: botoesFromMensagem(mensagem),
    autorNome,
    editMessageId: mensagem.id,
    editChannelId: mensagem.channelId
  };
}

async function handleEditarEmbedContext(interaction) {
  const mensagem = interaction.targetMessage;

  if (!mensagem) {
    await interaction.reply({ content: "❌ Não achei essa mensagem.", ephemeral: true });
    return;
  }

  if (!client.user || mensagem.author.id !== client.user.id) {
    await interaction.reply({
      content: "❌ Só dá pra editar embeds que eu postei pelo `/embed`.",
      ephemeral: true
    });
    return;
  }

  if (!mensagem.embeds.length) {
    await interaction.reply({
      content: "❌ Essa mensagem não tem embed pra editar.",
      ephemeral: true
    });
    return;
  }

  const draft = draftFromMensagem(mensagem, interaction.user.username);
  embedDrafts.set(interaction.user.id, draft);

  await interaction.reply({
    ...payloadEmbedBuilder(draft),
    ephemeral: true
  });

  console.log("✅ Apps → Editar embed aberto");
}

// Tudo que o construtor mostra: texto com a lista de botões + prévia + controles
function payloadEmbedBuilder(draft) {
  const botoes = draft.botoes || [];
  const partes = [];

  if (draft.editMessageId) {
    partes.push("✏️ Editando o embed publicado. Clique em **Salvar alterações** pra atualizar a mensagem.");
  }
  if (botoes.length > 0) {
    partes.push(`**Botões do embed (${botoes.length}/${EMBED_BOTOES_MAX}):**\n${botoes.map(descreverBotao).join("\n")}`);
  }

  return {
    content: partes.length > 0 ? partes.join("\n\n") : null,
    embeds: [montarPreviewEmbed(draft)],
    components: montarComponentesEmbedBuilder(draft),
    allowedMentions: { parse: [] }
  };
}

function montarPreviewEmbed(draft) {
  const cor = draft.cor === null ? Math.floor(Math.random() * 0xffffff) : draft.cor;

  const embed = new EmbedBuilder()
    .setTitle(draft.titulo)
    .setDescription(draft.descricao)
    .setColor(cor)
    .setFooter({ text: draft.footer || `Postado por ${draft.autorNome}` });

  if (draft.imagemUrl) embed.setImage(draft.imagemUrl);
  if (draft.linkTitulo) embed.setURL(draft.linkTitulo);

  return embed;
}

function montarComponentesEmbedBuilder(draft) {
  const editando = Boolean(draft?.editMessageId);

  const linhaCanal = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId("embedbuilder_canal")
      .setPlaceholder(editando ? "📌 Canal travado (editando a mensagem)" : "📌 Escolher canal (padrão: este canal)")
      .addChannelTypes(ChannelType.GuildText)
      .setDisabled(editando)
  );

  const linhaCor = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("embedbuilder_cor")
      .setPlaceholder("🎨 Escolher cor")
      .addOptions(
        Object.entries(CORES_EMBED).map(([id, cor]) => ({
          label: cor.nome,
          value: id
        }))
      )
  );

  const linhaBotoes1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("embedbuilder_titulo").setLabel("📝 Título").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("embedbuilder_descricao").setLabel("📄 Texto").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("embedbuilder_imagem").setLabel("🖼️ Imagem").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("embedbuilder_footer").setLabel("📌 Rodapé").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("embedbuilder_link").setLabel("🔗 Link do título").setStyle(ButtonStyle.Secondary)
  );

  const linhaBotoes2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("embedbuilder_publicar")
      .setLabel(editando ? "💾 Salvar alterações" : "✅ Publicar")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("embedbuilder_cancelar").setLabel("❌ Cancelar").setStyle(ButtonStyle.Danger)
  );

  const linhaBotaoTipo = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("embedbuilder_botao_tipo")
      .setPlaceholder("🔘 Adicionar botão ao embed")
      .addOptions([
        { label: "🔗 Botão de link", description: "Abre um site quando clicar", value: "link" },
        { label: "🎭 Botão de cargo", description: "Dá ou tira um cargo de quem clicar", value: "cargo" },
        { label: "💬 Botão de resposta", description: "Manda uma mensagem só pra quem clicar", value: "msg" },
        { label: "🗑️ Remover todos os botões", description: "Limpa os botões deste embed", value: "limpar" }
      ])
  );

  return [linhaCanal, linhaCor, linhaBotaoTipo, linhaBotoes1, linhaBotoes2];
}

async function handleEmbedBuilderInteraction(interaction) {
  const userId = interaction.user.id;
  const draft = embedDrafts.get(userId);

  if (!draft) {
    const resposta = { content: "❌ Essa sessão de embed expirou. Roda `/embed` de novo.", ephemeral: true };
    if (interaction.isModalSubmit() || interaction.isMessageComponent()) {
      await interaction.reply(resposta).catch(() => {});
    }
    return;
  }

  // Botões que abrem um modal (título, texto, imagem, rodapé, link)
  if (interaction.isButton() && ["embedbuilder_titulo", "embedbuilder_descricao", "embedbuilder_imagem", "embedbuilder_footer", "embedbuilder_link"].includes(interaction.customId)) {
    const campoMap = {
      embedbuilder_titulo: {
        customId: "embedbuilder_modal_titulo",
        titulo: "Título do embed",
        label: "Título",
        valorAtual: draft.titulo || "",
        estilo: TextInputStyle.Short,
        max: 256,
        obrigatorio: true
      },
      embedbuilder_descricao: {
        customId: "embedbuilder_modal_descricao",
        titulo: "Texto do embed",
        label: "Descrição",
        valorAtual: (draft.descricao || "").slice(0, 4000),
        estilo: TextInputStyle.Paragraph,
        max: 4000,
        obrigatorio: true
      },
      embedbuilder_imagem: {
        customId: "embedbuilder_modal_imagem",
        titulo: "Link da imagem",
        label: "URL da imagem (vazio = remover)",
        valorAtual: draft.imagemUrl || "",
        estilo: TextInputStyle.Short,
        max: 400,
        obrigatorio: false
      },
      embedbuilder_footer: {
        customId: "embedbuilder_modal_footer",
        titulo: "Rodapé do embed",
        label: "Texto do rodapé (vazio = remover)",
        valorAtual: draft.footer || "",
        estilo: TextInputStyle.Short,
        max: 2048,
        obrigatorio: false
      },
      embedbuilder_link: {
        customId: "embedbuilder_modal_link",
        titulo: "Link do título",
        label: "URL que o título vai abrir (vazio = remover)",
        valorAtual: draft.linkTitulo || "",
        estilo: TextInputStyle.Short,
        max: 400,
        obrigatorio: false
      }
    };

    const campo = campoMap[interaction.customId];

    const modal = new ModalBuilder().setCustomId(campo.customId).setTitle(campo.titulo);
    const input = new TextInputBuilder()
      .setCustomId("valor")
      .setLabel(campo.label)
      .setStyle(campo.estilo || TextInputStyle.Short)
      .setRequired(Boolean(campo.obrigatorio))
      .setMaxLength(campo.max || 400);

    if (campo.valorAtual) input.setValue(campo.valorAtual);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
    return;
  }

  // Escolha do tipo de botão (abre um formulário pra definir o que ele faz)
  if (interaction.isStringSelectMenu() && interaction.customId === "embedbuilder_botao_tipo") {
    const tipo = interaction.values[0];

    if (tipo === "limpar") {
      draft.botoes = [];
      await interaction.update(payloadEmbedBuilder(draft));
      return;
    }

    if ((draft.botoes || []).length >= EMBED_BOTOES_MAX) {
      await interaction.reply({
        content: `❌ Já tem ${EMBED_BOTOES_MAX} botões (o máximo). Remove os botões e adiciona de novo se quiser trocar.`,
        ephemeral: true
      });
      return;
    }

    const config = {
      link: { titulo: "Botão de link", label: "URL que o botão abre (https://...)", estilo: TextInputStyle.Short, max: 300 },
      cargo: { titulo: "Botão de cargo", label: "Cargo (nome, ID ou @menção)", estilo: TextInputStyle.Short, max: 100 },
      msg: { titulo: "Botão de resposta", label: `Mensagem da resposta (até ${EMBED_BOTAO_MSG_MAX} letras)`, estilo: TextInputStyle.Short, max: EMBED_BOTAO_MSG_MAX }
    }[tipo];

    const modal = new ModalBuilder()
      .setCustomId(`embedbuilder_modal_botao_${tipo}`)
      .setTitle(config.titulo);

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("label")
          .setLabel("Texto que aparece no botão")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(80)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("valor")
          .setLabel(config.label)
          .setStyle(config.estilo)
          .setRequired(true)
          .setMaxLength(config.max)
      )
    );

    await interaction.showModal(modal);
    return;
  }

  // Seleção de cor
  if (interaction.isStringSelectMenu() && interaction.customId === "embedbuilder_cor") {
    draft.cor = CORES_EMBED[interaction.values[0]].valor;
    await interaction.update(payloadEmbedBuilder(draft));
    return;
  }

  // Seleção de canal
  if (interaction.isChannelSelectMenu() && interaction.customId === "embedbuilder_canal") {
    draft.canalId = interaction.values[0];
    await interaction.update(payloadEmbedBuilder(draft));
    return;
  }

  // Publicar / salvar edição
  if (interaction.isButton() && interaction.customId === "embedbuilder_publicar") {
    if (draft.editMessageId) {
      const canal = await interaction.guild.channels.fetch(draft.editChannelId).catch(() => null);
      const mensagem = canal
        ? await canal.messages.fetch(draft.editMessageId).catch(() => null)
        : null;

      if (!mensagem) {
        await interaction.reply({ content: "❌ Não achei a mensagem original pra editar.", ephemeral: true });
        return;
      }

      try {
        await mensagem.edit({
          embeds: [montarPreviewEmbed(draft)],
          components: montarBotoesPublicos(draft.botoes)
        });
        embedDrafts.delete(userId);
        await interaction.update({ content: `✅ Embed atualizado em ${canal}.`, embeds: [], components: [] });
      } catch (error) {
        console.error("❌ Erro ao editar embed:", error);
        await interaction.reply({
          content: "❌ Não consegui editar essa mensagem. Confere se eu tenho permissão no canal.",
          ephemeral: true
        });
      }
      return;
    }

    const canal = draft.canalId
      ? await interaction.guild.channels.fetch(draft.canalId).catch(() => null)
      : interaction.channel;

    if (!canal) {
      await interaction.reply({ content: "❌ Não achei o canal escolhido.", ephemeral: true });
      return;
    }

    try {
      await canal.send({ embeds: [montarPreviewEmbed(draft)], components: montarBotoesPublicos(draft.botoes) });
      embedDrafts.delete(userId);
      await interaction.update({ content: `✅ Anúncio postado em ${canal}.`, embeds: [], components: [] });
    } catch (error) {
      console.error("❌ Erro ao publicar embed:", error);
      await interaction.reply({
        content: "❌ Não consegui postar nesse canal. Confere se eu tenho permissão lá.",
        ephemeral: true
      });
    }
    return;
  }

  // Cancelar
  if (interaction.isButton() && interaction.customId === "embedbuilder_cancelar") {
    embedDrafts.delete(userId);
    await interaction.update({ content: "❌ Cancelado.", embeds: [], components: [] });
    return;
  }

  // Retorno do formulário de botão
  if (interaction.isModalSubmit() && interaction.customId.startsWith("embedbuilder_modal_botao_")) {
    const tipo = interaction.customId.replace("embedbuilder_modal_botao_", "");
    const label = interaction.fields.getTextInputValue("label").trim();
    const valor = interaction.fields.getTextInputValue("valor").trim();

    const erro = async mensagem => {
      await interaction.reply({ content: `❌ ${mensagem}`, ephemeral: true });
    };

    if (!label) return erro("O botão precisa de um texto.");
    if ((draft.botoes || []).length >= EMBED_BOTOES_MAX) return erro(`Máximo de ${EMBED_BOTOES_MAX} botões.`);

    let botao;

    if (tipo === "link") {
      if (!urlValida(valor)) return erro("O link precisa começar com http:// ou https://");
      botao = { tipo: "link", label, url: valor };
    } else if (tipo === "cargo") {
      const membroCriador = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
      const role = acharCargoPorTexto(interaction.guild, valor);
      const motivo = validarCargoParaBotao(interaction.guild, role, membroCriador);
      if (motivo) return erro(motivo);
      botao = { tipo: "cargo", label, roleId: role.id };
    } else if (tipo === "msg") {
      botao = { tipo: "msg", label, texto: valor.slice(0, EMBED_BOTAO_MSG_MAX) };
    } else {
      return erro("Tipo de botão desconhecido.");
    }

    // dois botões iguais gerariam o mesmo ID interno e o Discord recusaria o embed
    const idNovo = customIdDoBotao(botao);
    if (idNovo && draft.botoes.some(b => customIdDoBotao(b) === idNovo)) {
      return erro("Já existe um botão igual a esse.");
    }

    draft.botoes.push(botao);
    await interaction.update(payloadEmbedBuilder(draft));
    return;
  }

  // Retorno dos modais (imagem, rodapé, link)
  if (interaction.isModalSubmit()) {
    const valor = interaction.fields.getTextInputValue("valor").trim();

    if (interaction.customId === "embedbuilder_modal_titulo") {
      if (!valor) {
        await interaction.reply({ content: "❌ O título não pode ficar vazio.", ephemeral: true });
        return;
      }
      draft.titulo = valor.slice(0, 256);
    } else if (interaction.customId === "embedbuilder_modal_descricao") {
      if (!valor) {
        await interaction.reply({ content: "❌ O texto não pode ficar vazio.", ephemeral: true });
        return;
      }
      draft.descricao = valor.slice(0, 4096);
    } else if (interaction.customId === "embedbuilder_modal_imagem") {
      draft.imagemUrl = urlValida(valor) ? valor : null;
    } else if (interaction.customId === "embedbuilder_modal_footer") {
      draft.footer = valor || null;
    } else if (interaction.customId === "embedbuilder_modal_link") {
      draft.linkTitulo = urlValida(valor) ? valor : null;
    }

    await interaction.update(payloadEmbedBuilder(draft));
    return;
  }
}

// Alguém clicou num botão de um embed publicado
async function handleEmbedBotaoClique(interaction) {
  const [, tipo, ...resto] = interaction.customId.split(":");
  const valor = resto.join(":");

  if (tipo === "msg") {
    await interaction.reply({ content: valor, ephemeral: true, allowedMentions: { parse: [] } });
    return;
  }

  if (tipo === "cargo") {
    const guild = interaction.guild;
    const role = guild.roles.cache.get(valor);

    // confere de novo na hora do clique: as permissões do cargo podem ter mudado
    const motivo = validarCargoParaBotao(guild, role, null);
    if (motivo) {
      await interaction.reply({ content: `❌ Esse botão não está funcionando: ${motivo}`, ephemeral: true });
      return;
    }

    try {
      const member = await guild.members.fetch(interaction.user.id);

      if (member.roles.cache.has(role.id)) {
        await member.roles.remove(role.id);
        await interaction.reply({ content: `➖ Tirei o cargo **${role.name}** de você.`, ephemeral: true });
      } else {
        await member.roles.add(role.id);
        await interaction.reply({ content: `➕ Você ganhou o cargo **${role.name}**!`, ephemeral: true });
      }
    } catch (error) {
      console.error("❌ Erro no botão de cargo:", error);
      await interaction.reply({ content: "❌ Não consegui mexer nesse cargo agora.", ephemeral: true }).catch(() => {});
    }
    return;
  }
}

// =========================
// INTERAÇÕES
// =========================
client.on("interactionCreate", async interaction => {
  // Componentes/modais do construtor de /embed (não são slash commands)
  if (interaction.customId && interaction.customId.startsWith("embedbuilder_")) {
    await handleEmbedBuilderInteraction(interaction);
    return;
  }

  // Botões que os admins criaram dentro de um /embed
  if (interaction.customId && interaction.customId.startsWith("embedbtn:")) {
    await handleEmbedBotaoClique(interaction);
    return;
  }

  // Componentes da Baguncinha Store
  if (interaction.customId && interaction.customId.startsWith("loja_")) {
    await handleLojaInteraction(interaction);
    return;
  }

  // Componentes do Pedra, Papel ou Tesoura
  if (interaction.customId && interaction.customId.startsWith("ppt:")) {
    await handlePptInteraction(interaction);
    return;
  }

  if (interaction.customId && interaction.customId.startsWith(VERIFICACAO_BTN_PREFIX)) {
    await handleVerificacaoBotao(interaction);
    return;
  }

  if (interaction.isMessageContextMenuCommand() && interaction.commandName === "Editar embed") {
    try {
      await handleEditarEmbedContext(interaction);
    } catch (error) {
      console.error("❌ Erro no Apps → Editar embed:", error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "❌ Não consegui abrir o editor desse embed.", ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) {
    return;
  }

  console.log(`📥 Comando recebido: /${interaction.commandName}`);

  const replyOriginal = interaction.reply.bind(interaction);
  const editOriginal = interaction.editReply.bind(interaction);
  const deferOriginal = interaction.deferReply.bind(interaction);
  let rankingAnexado = false;
  let skipRanking = false;
  const RANK_A_CADA = 8;
  const dadosRank = getUserData(interaction.user.id);
  dadosRank.comandosDesdeRank = (dadosRank.comandosDesdeRank || 0) + 1;
  const mostrarRanking = dadosRank.comandosDesdeRank >= RANK_A_CADA;
  if (mostrarRanking) dadosRank.comandosDesdeRank = 0;
  salvarDados();

  interaction.deferReply = async options => {
    if (options && options.ephemeral) skipRanking = true;
    return deferOriginal(options);
  };

  const payloadComRanking = async options => {
    if (interaction.commandName === "rank" || rankingAnexado || skipRanking || !mostrarRanking) return options;
    const ephemeral = typeof options === "object" && options !== null && options.ephemeral;
    if (ephemeral) return options;

    try {
      const rankEmbed = await montarEmbedRanking(10);
      rankingAnexado = true;
      if (typeof options === "string") {
        return { content: options, embeds: [rankEmbed] };
      }
      const embeds = Array.isArray(options?.embeds) ? [...options.embeds, rankEmbed] : [rankEmbed];
      return { ...options, embeds: embeds.slice(0, 10) };
    } catch (error) {
      console.error("Nao consegui montar o ranking:", error.message);
      return options;
    }
  };

  interaction.reply = async options => replyOriginal(await payloadComRanking(options));
  interaction.editReply = async options => editOriginal(await payloadComRanking(options));

  try {
    if (interaction.guild) {
      atualizarTop1(interaction.guild).catch(() => {});
    }
    // =========================
    // PING
    // =========================
    if (interaction.commandName === "ping") {
      await interaction.reply(
        `🏓 Salve! Tô on.\nPing: **${client.ws.ping}ms**`
      );
      console.log("✅ /ping respondido");
      return;
    }

    // =========================
    // HELP
    // =========================
    if (interaction.commandName === "help") {
      await interaction.reply(
        "**🤖 Bot Baguncinha — oq posso fazer no server**\n\n" +
        "🏓 `/ping` — Confere se eu tô on e de boa.\n" +
        "❓ `/help` — mostra todos os comandos disponivel.\n" +
        "🖼️ `/avatar` — Manda a foto de alguém em HD.\n" +
        "👤 `/userinfo` — Perfil completo da pessoa.\n" +
        "🏠 `/serverinfo` — Os dados do nosso servidor.\n" +
        "🧹 `/clear` — Zera as mensagem (só staff).\n" +
        "⏰ `/lembrete` — Te dou um toque na hora programada.\n" +
        "📊 `/perfil` — Teu nível e XP no servidor.\n" +
        "🏆 `/rank` — Quem tá mandando mais no server todo.\n" +
        "💰 `/rankmoedas` — Ranking de quem tem mais moedas.\n" +
        "📢 `/embed` — Cria um anúncio bonito (só staff).\n" +
        "💰 `/carteira` — Vê quantas moedas você tem (carteira + banco).\n" +
        "🏦 `/banco` — Guarda moedas no banco (protegidas de roubo) ou saca.\n" +
        "🎁 `/daily` — Recompensa diária de 250 a 500 moedas.\n" +
        "💼 `/trabalhar` — Faz um trampo por moedas.\n" +
        "🎣 `/pescar` — Pesca por moedas (risco de dar red).\n" +
        "🕵️ `/roubar` — Minigame pra assaltar alguém; se for pego paga 40% do valor da vítima e vai PRESO.\n" +
        "🤝 `/doar` — Doa moedas pra outra pessoa.\n" +
        "🎪 `/loja` — Abre a Baguncinha Store com prévia dos itens.\n" +
        "🛍️ `/comprar` — Compra um item da loja direto por comando.\n" +
        "🪙 `/apostar` — Aposta suas moedas em cara ou coroa.\n" +
        "🎰 `/roleta` — Aposta moedas na Roleta.\n" +
        "🪨 `/ppt` — Desafia alguém pra Pedra, Papel ou Tesoura apostando moedas.\n" +
        "🏆 `/conquistas` — Vê e resgata suas conquistas do servidor.\n" +
        "⚽ `/jogos` — Próximos jogos do Brasileirão, Libertadores e da Seleção.\n"
      );
      console.log("✅ /help respondido");
      return;
    }

    // =========================
    // AVATAR
    // =========================
    if (interaction.commandName === "avatar") {
      const user = interaction.options.getUser("usuario") || interaction.user;

      const embed = new EmbedBuilder()
        .setTitle(`Foto de ${user.username}`)
        .setImage(user.displayAvatarURL({ size: 1024, extension: "png" }))
        .setColor(0x5865f2);

      await interaction.reply({ embeds: [embed] });
      console.log("✅ /avatar respondido");
      return;
    }

    // =========================
    // USERINFO
    // =========================
    if (interaction.commandName === "userinfo") {
      const user = interaction.options.getUser("usuario") || interaction.user;
      const member = await interaction.guild.members.fetch(user.id);

      const embed = new EmbedBuilder()
        .setTitle(`Perfil de ${user.username}`)
        .setThumbnail(user.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: "ID", value: user.id, inline: true },
          { name: "Apelido", value: member.nickname || "Nenhum", inline: true },
          { name: "Cargos", value: `${member.roles.cache.size - 1}`, inline: true },
          { name: "Chegou na área", value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` },
          { name: "Conta criada", value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R>` }
        )
        .setColor(0x5865f2);

      await interaction.reply({ embeds: [embed] });
      console.log("✅ /userinfo respondido");
      return;
    }

    // =========================
    // SERVERINFO
    // =========================
    if (interaction.commandName === "serverinfo") {
      const guild = interaction.guild;

      const embed = new EmbedBuilder()
        .setTitle(`Dados da quebrada — ${guild.name}`)
        .setThumbnail(guild.iconURL({ size: 256 }) || null)
        .addFields(
          { name: "Membros", value: `${guild.memberCount}`, inline: true },
          { name: "Cargos", value: `${guild.roles.cache.size}`, inline: true },
          { name: "Canais", value: `${guild.channels.cache.size}`, inline: true },
          { name: "Fundado em", value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>` }
        )
        .setColor(0x5865f2);

      await interaction.reply({ embeds: [embed] });
      console.log("✅ /serverinfo respondido");
      return;
    }

    // =========================
    // CLEAR
    // =========================
    if (interaction.commandName === "clear") {
      const quantidade = interaction.options.getInteger("quantidade");

      await interaction.deferReply({ ephemeral: true });

      const deleted = await interaction.channel.bulkDelete(quantidade, true);

      await interaction.editReply(
        `🧹 Pronto, sumi com essas ${deleted.size} mensagem(ns) meu parceiro.`
      );
      console.log("✅ /clear respondido");
      return;
    }

    // =========================
    // LEMBRETE
    // =========================
    if (interaction.commandName === "lembrete") {
      const minutos = interaction.options.getInteger("minutos");
      const mensagem = interaction.options.getString("mensagem");

      await interaction.reply(
        `⏰ certo! Te dou um toque em **${minutos} minuto(s)**: "${mensagem}"`
      );

      setTimeout(() => {
        interaction.followUp(
          `🔔 Ô ${interaction.user}, chegou a hora: **${mensagem}**`
        ).catch(() => {});
      }, minutos * 60 * 1000);

      console.log("✅ /lembrete respondido");
      return;
    }

    // =========================
    // PERFIL
    // =========================
    if (interaction.commandName === "perfil") {
      const user = interaction.options.getUser("usuario") || interaction.user;
      const data = getUserData(user.id);
      const totalLevel = getTotalLevel(data);
      const cargoAtualId = getRoleIdForLevel(totalLevel);
      const cargoTexto = cargoAtualId && !cargoAtualId.startsWith("COLOQUE_")
        ? `<@&${cargoAtualId}>`
        : "Nenhum ainda";

      const embed = new EmbedBuilder()
        .setTitle(`Perfil de ${user.username}`)
        .setThumbnail(user.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: "💬 Nível de texto", value: `${data.textLevel} (${data.textXp}/${xpForNextLevel(data.textLevel, "text")} XP)`, inline: true },
          { name: "🎙️ Nível de voz", value: `${data.voiceLevel} (${data.voiceXp}/${xpForNextLevel(data.voiceLevel, "voice")} XP)`, inline: true },
          { name: "⭐ Nível de atividade", value: `${totalLevel} (o maior entre os dois)`, inline: true },
          { name: "Cargo pela correria", value: cargoTexto }
        )
        .setColor(0x57f287);

      await interaction.reply({ embeds: [embed] });
      console.log("✅ /perfil respondido");
      return;
    }

    // =========================
    // RANK (LEADERBOARD)
    // =========================
    if (interaction.commandName === "rank") {
      const embed = await montarEmbedRanking(10);
      await interaction.reply({ embeds: [embed] });
      await atualizarTop1(interaction.guild);
      console.log("/rank respondido");
      return;
    }

    // =========================
    // RANK DE MOEDAS
    // =========================
    if (interaction.commandName === "rankmoedas") {
      const ranking = [...xpData.entries()]
        .map(([userId, dados]) => [userId, normalizarDadosUsuario(dados)])
        .sort((a, b) => getTotalMoedas(b[1]) - getTotalMoedas(a[1]))
        .slice(0, 10);

      if (ranking.length === 0) {
        await interaction.reply("Ninguém tem moeda nenhuma ainda. Usa `/daily` ou `/trabalhar`!");
        return;
      }

      const MEDALHAS = ["🥇", "🥈", "🥉"];

      const usuarios = await Promise.all(
        ranking.map(([userId]) => client.users.fetch(userId).catch(() => null))
      );

      const linhas = ranking.map(([, data], index) => {
        const user = usuarios[index];
        const nome = user ? user.username : "Usuário desconhecido";
        const posicao = MEDALHAS[index] || `**${index + 1}.**`;
        const detalheBanco = data.banco > 0
          ? ` _(carteira ${formatarMoedas(data.coins)} + banco ${formatarMoedas(data.banco)})_`
          : "";
        return `${posicao} **${nome}** — ${formatarMoedas(getTotalMoedas(data))}${detalheBanco}`;
      });

      const embed = new EmbedBuilder()
        .setTitle("💰 Ranking de Moedas")
        .setDescription(linhas.join("\n"))
        .setColor(0xf1c40f)
        .setThumbnail(usuarios[0]?.displayAvatarURL({ size: 256 }) || null);

      await interaction.reply({ embeds: [embed] });
      console.log("✅ /rankmoedas respondido");
      return;
    }

    // =========================
    // EMBED (STAFF)
    // =========================
    if (interaction.commandName === "embed") {
      const titulo = interaction.options.getString("titulo");
      const descricao = interaction.options.getString("descricao").replace(/\\n/g, "\n");

      const draft = {
        titulo,
        descricao,
        cor: 0x5865f2,
        imagemUrl: null,
        footer: null,
        linkTitulo: null,
        canalId: null,
        botoes: [],
        autorNome: interaction.user.username
      };

      embedDrafts.set(interaction.user.id, draft);

      await interaction.reply({
        ...payloadEmbedBuilder(draft),
        ephemeral: true
      });

      console.log("✅ /embed (construtor) aberto");
      return;
    }

    // =========================
    // CARTEIRA
    // =========================
    if (interaction.commandName === "carteira") {
      const user = interaction.options.getUser("usuario") || interaction.user;
      const data = getUserData(user.id);

      await interaction.reply(
        `💰 A carteira de **${user.username}** tá com ${formatarMoedas(data.coins)}.\n` +
        `🏦 No banco: ${formatarMoedas(data.banco)} (total ${formatarMoedas(getTotalMoedas(data))}).\n` +
        `🎫 Tickets de sorteio: **${data.ticketsSorteio || 0}**.`
      );
      console.log("✅ /carteira respondido");
      return;
    }

    // =========================
    // BANCO
    // =========================
    if (interaction.commandName === "banco") {
      const data = getUserData(interaction.user.id);
      const acao = interaction.options.getString("acao") || "ver";
      const quantidade = interaction.options.getInteger("quantidade");

      const resumoBanco = () =>
        `🏦 **Banco de ${interaction.user.username}**\n` +
        `👛 Carteira: ${formatarMoedas(data.coins)}\n` +
        `🏦 Banco: ${formatarMoedas(data.banco)}\n` +
        `💰 Total: ${formatarMoedas(getTotalMoedas(data))}\n\n` +
        `_Moedas no banco ficam protegidas de roubos — só a carteira pode ser assaltada._`;

      if (acao === "ver") {
        await interaction.reply({ content: resumoBanco() });
        console.log("✅ /banco (ver) respondido");
        return;
      }

      const valor = acao === "depositar_tudo"
        ? data.coins
        : acao === "sacar_tudo"
          ? data.banco
          : quantidade;

      if (!valor || valor <= 0) {
        await interaction.reply({
          content: "❌ Diz a quantidade que você quer mover (ou use *Depositar tudo* / *Sacar tudo*).",
          ephemeral: true
        });
        return;
      }

      const depositando = acao === "depositar" || acao === "depositar_tudo";

      if (depositando) {
        if (data.coins < valor) {
          await interaction.reply({
            content: `❌ Você só tem ${formatarMoedas(data.coins)} na carteira.`,
            ephemeral: true
          });
          return;
        }
        data.coins -= valor;
        data.banco += valor;
      } else {
        if (data.banco < valor) {
          await interaction.reply({
            content: `❌ Você só tem ${formatarMoedas(data.banco)} no banco.`,
            ephemeral: true
          });
          return;
        }
        data.banco -= valor;
        data.coins += valor;
      }

      salvarDados();

      await interaction.reply({
        content: `✅ ${depositando ? "Depositaste" : "Sacaste"} ${formatarMoedas(valor)}.\n\n${resumoBanco()}`
      });
      console.log("✅ /banco respondido");
      return;
    }

    // =========================
    // DAILY
    // =========================
    if (interaction.commandName === "daily") {
      const data = getUserData(interaction.user.id);
      const now = Date.now();

      if (now - data.lastDaily < DAILY_COOLDOWN_MS) {
        const restante = DAILY_COOLDOWN_MS - (now - data.lastDaily);
        const horas = Math.ceil(restante / (60 * 60 * 1000));
        await interaction.reply({
          content: `⏳ Você já pegou seu daily. Volta em ~${horas}h.`,
          ephemeral: true
        });
        return;
      }

      const ganho = Math.floor(Math.random() * (DAILY_MAX - DAILY_MIN + 1)) + DAILY_MIN;
      data.coins += ganho;
      data.lastDaily = now;

      await verificarMarcosMoedas(interaction.guild, interaction.user.id, data);
      salvarDados();

      await interaction.reply(`🎁 Você resgatou seu presente diario e ganhou ${formatarMoedas(ganho)}!`);
      console.log("✅ /daily respondido");
      return;
    }

    // =========================
    // TRABALHAR
    // =========================
    if (interaction.commandName === "trabalhar") {
      const data = getUserData(interaction.user.id);
      const now = Date.now();

      const mensagemPrisao = checarPrisao(data);
      if (mensagemPrisao) {
        await interaction.reply({ content: mensagemPrisao, ephemeral: true });
        return;
      }

      const trabalharCooldown = getTrabalharCooldown(data);
      if (now - data.lastTrabalhar < trabalharCooldown) {
        const restante = trabalharCooldown - (now - data.lastTrabalhar);
        const minutos = Math.ceil(restante / (60 * 1000));
        await interaction.reply({
          content: `⏳ Você já trabalhou hoje. Volta em ~${minutos} min.`,
          ephemeral: true
        });
        return;
      }

      const TRAMPOS = [
        "entregou uns panfleto",
        "lavou uns carro na rua",
        "ajudou a organizar o mercado",
        "fez um freela de design",
        "vendeu uns doce na praça",
        "trabalhou de flanelinha",
        "trabalhou de ambulante",
        "trabalhou de entregador da shopee",
        "trabalhou de faxineiro(a)",
        "trabalhou de jardineiro",
        "trabalhou de ajudante de pedreiro"
      ];
      const trampo = TRAMPOS[Math.floor(Math.random() * TRAMPOS.length)];
      const ganho = Math.floor(Math.random() * 81) + 50; // 50 a 130

      data.coins += ganho;
      data.lastTrabalhar = now;

      await verificarMarcosMoedas(interaction.guild, interaction.user.id, data);
      salvarDados();

      await interaction.reply(`💼 Você ${trampo} e faturou ${formatarMoedas(ganho)}.`);
      console.log("✅ /trabalhar respondido");
      return;
    }

    // =========================
    // PESCAR
    // =========================
    if (interaction.commandName === "pescar") {
      const data = getUserData(interaction.user.id);
      const now = Date.now();

      const mensagemPrisao = checarPrisao(data);
      if (mensagemPrisao) {
        await interaction.reply({ content: mensagemPrisao, ephemeral: true });
        return;
      }

      if (now - data.lastPescar < PESCAR_COOLDOWN_MS) {
        const restante = PESCAR_COOLDOWN_MS - (now - data.lastPescar);
        const minutos = Math.ceil(restante / (60 * 1000));
        await interaction.reply({
          content: `⏳ Sua vara ainda tá descansando. Volta em ~${minutos} min.`,
          ephemeral: true
        });
        return;
      }

      data.lastPescar = now;

      const deuNada = Math.random() < 0.25; // 25% de chance de não pegar nada

      if (deuNada) {
        await interaction.reply("🎣 Você ficou horas na beira do rio e não fisgou nada. Mais Sorte no próximo mn.");
        console.log("✅ /pescar respondido (nada)");
        return;
      }

      const ganho = Math.floor(Math.random() * 91) + 20; // 20 a 110
      data.coins += ganho;

      await verificarMarcosMoedas(interaction.guild, interaction.user.id, data);
      salvarDados();

      await interaction.reply(`🎣 Fisgou um peixe daora e vendeu por ${formatarMoedas(ganho)}!`);
      console.log("✅ /pescar respondido");
      return;
    }

    // =========================
    // ROUBAR
    // =========================
    if (interaction.commandName === "roubar") {
      const alvo = interaction.options.getUser("usuario");

      if (alvo.id === interaction.user.id) {
        await interaction.reply({ content: "❌ Não dá pra roubar de si mesmo, mn. (???)", ephemeral: true });
        return;
      }
      if (alvo.bot) {
        await interaction.reply({ content: "❌ ta achando que ta facil assim ė?.", ephemeral: true });
        return;
      }

      const ladrao = getUserData(interaction.user.id);
      const vitima = getUserData(alvo.id);
      const now = Date.now();

      const mensagemPrisao = checarPrisao(ladrao);
      if (mensagemPrisao) {
        await interaction.reply({ content: mensagemPrisao, ephemeral: true });
        return;
      }

      if (now - ladrao.lastRoubar < ROUBAR_COOLDOWN_MS) {
        const restante = ROUBAR_COOLDOWN_MS - (now - ladrao.lastRoubar);
        const minutos = Math.ceil(restante / (60 * 1000));
        await interaction.reply({
          content: `⏳ Tá muito na cara, espera uns ~${minutos} min antes de tentar de novo.`,
          ephemeral: true
        });
        return;
      }

      if (vitima.coins < ROUBO_MIN_VITIMA) {
        await interaction.reply({
          content: `❌ ${alvo.username} tá quebrado, não vale nem a pena tentar.`,
          ephemeral: true
        });
        return;
      }

      ladrao.lastRoubar = now;
      salvarDados(); // já garante o cooldown mesmo se o bot reiniciar no meio do minigame

      await iniciarRouboMinigame(interaction, alvo, ladrao, vitima);
      console.log("✅ /roubar (minigame) respondido");
      return;
    }

    // =========================
    // DOAR
    // =========================
    if (interaction.commandName === "doar") {
      const alvo = interaction.options.getUser("usuario");
      const quantidade = interaction.options.getInteger("quantidade");

      if (alvo.id === interaction.user.id) {
        await interaction.reply({ content: "❌ Não dá pra doar pra si mesmo mn (???).", ephemeral: true });
        return;
      }
      if (alvo.bot) {
        await interaction.reply({ content: "❌ ta me chamando de duro?.", ephemeral: true });
        return;
      }

      const doador = getUserData(interaction.user.id);

      if (doador.coins < quantidade) {
        await interaction.reply({
          content: `❌ Você não tem ${formatarMoedas(quantidade)} pra doar. Sua carteira: ${formatarMoedas(doador.coins)}.`,
          ephemeral: true
        });
        return;
      }

      const recebedor = getUserData(alvo.id);

      doador.coins -= quantidade;
      recebedor.coins += quantidade;

      await verificarMarcosMoedas(interaction.guild, alvo.id, recebedor);
      salvarDados();

      await interaction.reply(
        `🤝 Você doou ${formatarMoedas(quantidade)} pra **${alvo.username}**. Bonito gesto mn.`
      );
      console.log("✅ /doar respondido");
      return;
    }

    // =========================
    // LOJA (embed + menus + botões)
    // =========================
    if (interaction.commandName === "loja") {
      await interaction.reply({
        embeds: [montarEmbedLojaPrincipal()],
        components: montarComponentesLojaPrincipal()
      });
      console.log("✅ /loja respondido");
      return;
    }

    // =========================
    // COMPRAR (atalho por comando)
    // =========================
    if (interaction.commandName === "comprar") {
      const itemId = interaction.options.getString("item");
      await comprarItem(interaction, itemId);
      console.log("✅ /comprar respondido");
      return;
    }

    // =========================
    // LOJA IMAGEM (SÓ O DONO)
    // =========================
    if (interaction.commandName === "lojaimagem") {
      if (!OWNER_ID || interaction.user.id !== OWNER_ID) {
        await interaction.reply({ content: "❌ Só o dono do bot pode mexer nas imagens da loja.", ephemeral: true });
        return;
      }

      const itemId = interaction.options.getString("item");
      const url = (interaction.options.getString("url") || "").trim();

      if (!LOJA_ITEMS[itemId]) {
        await interaction.reply({ content: "❌ Esse item não existe.", ephemeral: true });
        return;
      }

      // sem URL = remove a imagem
      if (!url) {
        delete lojaImagens[itemId];
        salvarDados();
        await interaction.reply({
          content: `🗑️ Imagem de **${LOJA_ITEMS[itemId].nome}** removida.`,
          ephemeral: true
        });
        console.log("✅ /lojaimagem (removida)");
        return;
      }

      if (!urlValida(url)) {
        await interaction.reply({ content: "❌ A URL precisa começar com http:// ou https://", ephemeral: true });
        return;
      }

      lojaImagens[itemId] = url;
      salvarDados();

      await interaction.reply({
        content: `✅ Imagem de **${LOJA_ITEMS[itemId].nome}** atualizada. Prévia abaixo:`,
        embeds: [montarEmbedItem(itemId)],
        ephemeral: true
      });
      console.log("✅ /lojaimagem respondido");
      return;
    }

    // =========================
    // APOSTAR
    // =========================
    if (interaction.commandName === "apostar") {
      const quantidade = interaction.options.getInteger("quantidade");
      const escolha = interaction.options.getString("escolha");
      const data = getUserData(interaction.user.id);

      if (data.coins < quantidade) {
        await interaction.reply({
          content: `❌ Você não tem ${formatarMoedas(quantidade)} pra apostar. Sua carteira: ${formatarMoedas(data.coins)}.`,
          ephemeral: true
        });
        return;
      }

      const resultado = Math.random() < 0.5 ? "cara" : "coroa";
      const ganhou = resultado === escolha;

      if (ganhou) {
        data.coins += quantidade;
        await verificarMarcosMoedas(interaction.guild, interaction.user.id, data);
        salvarDados();

        await interaction.reply(
          `🪙 Deu **${resultado}**! Você dobrou a aposta e ganhou ${formatarMoedas(quantidade)}.`
        );
      } else {
        data.coins -= quantidade;
        salvarDados();

        await interaction.reply(
          `🪙 Deu **${resultado}**... você perdeu ${formatarMoedas(quantidade)}. Próxima.`
        );
      }

      console.log("✅ /apostar respondido");
      return;
    }

    // =========================
    // ROLETA
    // =========================
    if (interaction.commandName === "roleta") {
      const quantidade = interaction.options.getInteger("quantidade");
      const data = getUserData(interaction.user.id);
      const now = Date.now();

      if (now - data.lastRoleta < ROLETA_COOLDOWN_MS) {
        const restante = ROLETA_COOLDOWN_MS - (now - data.lastRoleta);
        const segundos = Math.ceil(restante / 1000);
        await interaction.reply({
          content: `⏳ A roleta ainda tá girando. Espera ~${segundos}s.`,
          ephemeral: true
        });
        return;
      }

      if (data.coins < quantidade) {
        await interaction.reply({
          content: `❌ Você não tem ${formatarMoedas(quantidade)}. Sua carteira: ${formatarMoedas(data.coins)}.`,
          ephemeral: true
        });
        return;
      }

      data.lastRoleta = now;
      data.coins -= quantidade;

      const resultado = sortearRoleta();
      const premio = Math.floor(quantidade * resultado.multiplicador);
      data.coins += premio;

      await verificarMarcosMoedas(interaction.guild, interaction.user.id, data);
      salvarDados();

      const embed = new EmbedBuilder()
        .setTitle("🎰 ROLETA BAGUNCINHA 🎰")
        .setDescription(
          `Você apostou ${formatarMoedas(quantidade)}.\n\n` +
          `${resultado.label}\n\n` +
          `Você ganhou: ${formatarMoedas(premio)}\n` +
          `Saldo atual: ${formatarMoedas(data.coins)}`
        )
        .setColor(resultado.multiplicador >= 5 ? 0xf1c40f : resultado.multiplicador === 0 ? 0xe74c3c : 0x2ecc71);

      await interaction.reply({ embeds: [embed] });
      console.log("✅ /roleta respondido");
      return;
    }

    // =========================
    // PPT (PEDRA, PAPEL OU TESOURA)
    // =========================
    if (interaction.commandName === "ppt") {
      const alvo = interaction.options.getUser("usuario");
      const quantidade = interaction.options.getInteger("quantidade");

      if (alvo.id === interaction.user.id) {
        await interaction.reply({ content: "❌ Não dá pra desafiar você mesmo.", ephemeral: true });
        return;
      }
      if (alvo.bot) {
        await interaction.reply({ content: "❌ Bot não joga PPT.", ephemeral: true });
        return;
      }

      const desafianteData = getUserData(interaction.user.id);
      if (desafianteData.coins < quantidade) {
        await interaction.reply({
          content: `❌ Você não tem ${formatarMoedas(quantidade)}. Sua carteira: ${formatarMoedas(desafianteData.coins)}.`,
          ephemeral: true
        });
        return;
      }

      const matchId = interaction.id;
      pptMatches.set(matchId, {
        desafianteId: interaction.user.id,
        desafiadoId: alvo.id,
        aposta: quantidade,
        status: "aguardando",
        escolhas: {}
      });

      const linhaBotoes = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`ppt:aceitar:${matchId}`).setLabel("✅ Aceitar").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`ppt:recusar:${matchId}`).setLabel("❌ Recusar").setStyle(ButtonStyle.Danger)
      );

      await interaction.reply({
        content: ` ${interaction.user} desafiou ${alvo} para Pedra, Papel ou Tesoura apostando ${formatarMoedas(quantidade)}!\n${alvo}, aceita?`,
        components: [linhaBotoes]
      });

      console.log("✅ /ppt respondido");
      return;
    }

    // =========================
    // CONQUISTAS
    // =========================
    if (interaction.commandName === "conquistas") {
      const data = getUserData(interaction.user.id);
      const member = await interaction.guild.members.fetch(interaction.user.id);

      const desbloqueadasAgora = await verificarConquistas(member, data);

      if (desbloqueadasAgora.length > 0) {
        await verificarMarcosMoedas(interaction.guild, interaction.user.id, data);
      }
      salvarDados();

      const linhas = Object.entries(CONQUISTAS).map(([id, conquista]) => {
        const status = data.conquistas.includes(id) ? "✅" : "🔒";
        return `${status} **${conquista.nome}** — ${conquista.descricao}`;
      });

      const embed = new EmbedBuilder()
        .setTitle(`🏆 Conquistas de ${interaction.user.username}`)
        .setDescription(linhas.join("\n"))
        .setColor(0xf1c40f);

      if (desbloqueadasAgora.length > 0) {
        embed.addFields({
          name: "🎉 Novas conquistas desbloqueadas!",
          value: desbloqueadasAgora
            .map(c => `${c.badge} ${c.nome} — +${formatarMoedas(c.moedas)}`)
            .join("\n")
        });
      }

      await interaction.reply({ embeds: [embed] });
      console.log("✅ /conquistas respondido");
      return;
    }

    // =========================
    // JOGOS (BRASILEIRÃO + SELEÇÃO)
    // =========================
    if (interaction.commandName === "jogos") {
      await interaction.deferReply();

      try {
        let fixtures;

        if (jogosCache.dados && Date.now() - jogosCache.timestamp < JOGOS_CACHE_MS) {
          fixtures = jogosCache.dados;
        } else {
          const agora = Date.now();
          const eventos = await coletarEventosFutebol();

          fixtures = eventos
            .filter(jogo => {
              const status = normalizarStatusFutebol(jogo.strStatus);
              const kickoff = parseKickoffMs(jogo);
              return status === "NS" || status === "LIVE" || (kickoff && kickoff >= agora - 3 * 60 * 60 * 1000);
            })
            .sort((a, b) => parseKickoffMs(a) - parseKickoffMs(b));

          jogosCache = { timestamp: Date.now(), dados: fixtures };
        }

        if (fixtures.length === 0) {
          await interaction.editReply("Não achei nenhum jogo marcado por enquanto.");
          return;
        }

        const linhas = fixtures
          .slice(0, 12)
          .map(jogo => {
            const status = normalizarStatusFutebol(jogo.strStatus);
            const prefixo = status === "LIVE" ? "🔴 AO VIVO " : "";
            return (
              `${prefixo}⚽ **${nomeMandante(jogo)} x ${nomeVisitante(jogo)}**\n` +
              `　　🏆 ${nomeCompeticao(jogo)} — 🕐 ${formatarHorarioJogo(parseKickoffMs(jogo))}`
            );
          });

        const embed = new EmbedBuilder()
          .setTitle("📅 Próximos jogos")
          .setDescription(linhas.join("\n\n"))
          .setColor(0x2ecc71)
          .setFooter({ text: "Fonte: TheSportsDB" });

        await interaction.editReply({ embeds: [embed] });
      } catch (error) {
        console.error("❌ Erro ao buscar jogos:", error);
        await interaction.editReply("❌ Deu ruim buscando os jogos. Tenta de novo mais tarde.");
      }

      console.log("✅ /jogos respondido");
      return;
    }

    // =========================
    // SORTEAR (STAFF)
    // =========================
    if (interaction.commandName === "sortear") {
      const premio = interaction.options.getString("premio");

      const participantes = [...xpData.entries()].filter(([, data]) => {
        return data && typeof data === "object" && (data.ticketsSorteio || 0) > 0;
      });

      if (participantes.length === 0) {
        await interaction.reply({
          content: "❌ Ninguém tem ticket de sorteio. Compra na `/loja` primeiro.",
          ephemeral: true
        });
        return;
      }

      const pool = [];
      let totalTickets = 0;
      for (const [userId, data] of participantes) {
        const tickets = data.ticketsSorteio;
        totalTickets += tickets;
        for (let i = 0; i < tickets; i++) {
          pool.push(userId);
        }
      }

      const vencedorId = pool[Math.floor(Math.random() * pool.length)];
      const ticketsVencedor = getUserData(vencedorId).ticketsSorteio;

      for (const [, data] of participantes) {
        data.ticketsSorteio = 0;
      }
      salvarDados();

      const vencedor = await client.users.fetch(vencedorId).catch(() => null);
      const nomeVencedor = vencedor ? vencedor.username : "Usuário desconhecido";

      const embed = new EmbedBuilder()
        .setTitle("🎫 Resultado do Sorteio")
        .setDescription(
          `🎉 O ganhador foi <@${vencedorId}> (**${nomeVencedor}**)!\n\n` +
          (premio ? `🎁 Prêmio: **${premio}**\n\n` : "") +
          `Tinha **${ticketsVencedor}** ticket(s) de **${totalTickets}** no total.\n` +
          `Participantes: **${participantes.length}**.`
        )
        .setColor(0xf1c40f)
        .setThumbnail(vencedor?.displayAvatarURL({ size: 256 }) || null)
        .setFooter({ text: "Todos os tickets foram consumidos neste sorteio." });

      await interaction.reply({ embeds: [embed] });
      console.log("✅ /sortear respondido");
      return;
    }

    // =========================
    // EDITAR MOEDAS (ADMIN)
    // =========================
    if (interaction.commandName === "editarmoedas") {
      const alvo = interaction.options.getUser("usuario");
      const acao = interaction.options.getString("acao");
      const quantidade = interaction.options.getInteger("quantidade");

      const data = getUserData(alvo.id);

      if (acao === "adicionar") {
        data.coins += quantidade;
      } else if (acao === "remover") {
        data.coins = Math.max(0, data.coins - quantidade);
      } else if (acao === "definir") {
        data.coins = quantidade;
      }

      await verificarMarcosMoedas(interaction.guild, alvo.id, data);
      salvarDados();

      await interaction.reply({
        content: `✅ Feito. Carteira de **${alvo.username}** agora tá em ${formatarMoedas(data.coins)}.`,
        ephemeral: true
      });
      console.log("✅ /editarmoedas respondido");
      return;
    }

    // =========================
    // BLOQUEAR CANAIS (ADMIN)
    // =========================
    if (interaction.commandName === "bloquearcanais") {
      if (NAO_VERIFICADO_ROLE_ID.startsWith("COLOQUE_")) {
        await interaction.reply({
          content: "❌ Configura o NAO_VERIFICADO_ROLE_ID no código antes de usar isso.",
          ephemeral: true
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      const guild = interaction.guild;
      const canalVerificacao = guild.channels.cache.find(
        c => c.name === "verificacao" && c.type === ChannelType.GuildText
      );

      let sucesso = 0;
      let falhas = 0;

      for (const canal of guild.channels.cache.values()) {
        if (canalVerificacao && canal.id === canalVerificacao.id) continue;
        if (!canal.permissionOverwrites) continue;

        try {
          await canal.permissionOverwrites.edit(NAO_VERIFICADO_ROLE_ID, { ViewChannel: false });
          sucesso++;
        } catch (error) {
          falhas++;
        }
      }

      if (canalVerificacao) {
        await canalVerificacao.permissionOverwrites
          .edit(NAO_VERIFICADO_ROLE_ID, { ViewChannel: true })
          .catch(() => {});
      }

      await interaction.editReply(
        `✅ Bloqueado em ${sucesso} canal(is).` +
        (falhas > 0 ? ` ⚠️ Falhou em ${falhas} (confere se meu cargo tá acima e se eu tenho "Gerenciar Cargos/Canais" lá).` : "")
      );
      console.log("✅ /bloquearcanais respondido");
      return;
    }

    // =========================
    // DESCONHECIDO
    // =========================
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "❌ Esse comando aí não existe, porra.",
        ephemeral: true
      });
    }

  } catch (error) {
    console.error("❌ ERRO AO RESPONDER INTERAÇÃO:");
    console.error(error);

    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({
          content: "❌ Deu ruim aqui, porra. Tenta de novo.",
          ephemeral: true
        });
      } else {
        await interaction.reply({
          content: "❌ Deu ruim aqui, porra. Tenta de novo.",
          ephemeral: true
        });
      }
    } catch (replyError) {
      console.error("❌ Não foi possível enviar mensagem de erro:");
      console.error(replyError);
    }
  }
});

// =========================
// ERROS DO CLIENTE
// =========================
client.on("error", error => {
  console.error("❌ Erro do Discord Client:");
  console.error(error);
});

client.on("warn", warning => {
  console.warn("⚠️ Aviso Discord:");
  console.warn(warning);
});

// =========================
// CARGOS POR INTERESSE (ONBOARDING NA ENTRADA)
// =========================
// Cole aqui os IDs dos cargos que cada interesse libera.
const INTEREST_ROLES = {
  valorant: "1476004304690348117",
  minecraft: "1553649152779485272",
  cs: "1553649152779485272",
  roblox: "1553649152779485272",
  fortnite: "COLOQUE_O_ID_DO_CARGO_FORTNITE",
  futebol: "COLOQUE_O_ID_DO_CARGO_FUTEBOL",
  nitros: "COLOQUE_O_ID_DO_CARGO_NITROS",
  promocao: "COLOQUE_O_ID_DO_CARGO_PROMOCAO",
  geral: "1373017679379828908"
};

const NOMES_INTERESSES = {
  valorant: "🎯 Valorant",
  minecraft: "⛏️ Minecraft",
  cs: "🔫 CS",
  roblox: "🧱 Roblox",
  fortnite: "🪂 Fortnite",
  futebol: "⚽ Futebol",
  nitros: "💎 Nitros",
  promocao: "🏷️ Promoções",
  geral: "💬 Geral"
};

async function ensureInterestRoles(guild) {
  if (!guild) return;

  await guild.roles.fetch().catch(() => {});

  for (const [interesse, nome] of Object.entries(NOMES_INTERESSES)) {
    const atual = INTEREST_ROLES[interesse];
    if (atual && !String(atual).startsWith("COLOQUE_")) {
      if (guild.roles.cache.has(atual)) continue;
    }

    const nomeCargo = nome.replace(/^[^\p{L}\p{N}]+/u, "").trim();
    let cargo = guild.roles.cache.find(r => r.name.toLowerCase() === nomeCargo.toLowerCase());

    if (!cargo) {
      try {
        cargo = await guild.roles.create({
          name: nomeCargo,
          mentionable: false,
          reason: `Cargo de interesse: ${nomeCargo}`
        });
        console.log(`✅ Cargo de interesse criado: ${nomeCargo} (${cargo.id})`);
      } catch (error) {
        console.error(`❌ Não consegui criar o cargo "${nomeCargo}":`, error.message);
        continue;
      }
    }

    INTEREST_ROLES[interesse] = cargo.id;
  }
}

// =========================
// SERVIDOR HTTP — RENDER (só pra manter o serviço vivo)
// =========================
const server = http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8"
  });
  res.end("🤖 Bot Baguncinha na área, tudo certo!");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Servidor HTTP rodando na porta ${PORT}`);
});

// =========================
// INICIALIZAÇÃO
// =========================
async function start() {
  try {
    if (!TOKEN || !CLIENT_ID) {
      console.error("❌ TOKEN ou CLIENT_ID ausente.");
      return;
    }

    await carregarDados();

    // Zera os saldos inflados uma única vez (ver ECONOMIA_RESET_VERSAO)
    aplicarResetEconomiaSeNecessario();

    await registerCommands();

    console.log("🔌 Conectando ao Discord...");
    await client.login(TOKEN);
  } catch (error) {
    console.error("❌ ERRO AO INICIAR O BOT:");
    console.error(error);
  }
}

// Salva no disco a cada 2 minutos
setInterval(salvarDados, 2 * 60 * 1000);

// Sobe pro GitHub a cada 5 minutos, mas só se algo mudou desde o último envio
setInterval(() => {
  if (dadosAlterados) githubSalvar();
}, GITHUB_SAVE_INTERVAL_MS);

// Quando o Render manda desligar (deploy novo, reinício), salva no disco E no GitHub
// antes de fechar — é isso que evita perder o progresso dos últimos minutos.
let encerrando = false;
async function encerrarComSalvamento() {
  if (encerrando) return;
  encerrando = true;

  console.log("💾 Salvando banco de dados antes de encerrar...");
  salvarDados();

  // se já tem um envio em andamento, espera ele terminar (até ~10s)
  for (let i = 0; i < 20 && salvandoGithub; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  await githubSalvar();

  process.exit(0);
}
process.on("SIGINT", encerrarComSalvamento);
process.on("SIGTERM", encerrarComSalvamento);

start();
