const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType
} = require("discord.js");
const http = require("http");

// =========================
// CONFIGURAÇÃO
// =========================
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = "1370256381701128192";
const PORT = process.env.PORT || 10000;
const FOOTBALL_API_KEY = process.env.API_FOOTBALL_KEY;

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
    GatewayIntentBits.GuildVoiceStates
  ]
});

// =========================
// "BANCO DE DADOS" EM MEMÓRIA (XP)
// ⚠️ Isso zera toda vez que o bot reinicia.
// Pra persistir de verdade, depois dá pra trocar por um arquivo JSON ou um banco (SQLite/Supabase).
// =========================
// XP de texto e de voz são contados separadamente (níveis independentes),
// mas os dois somam pro "nível total", que é o que libera os cargos por atividade.
const xpData = new Map(); // key: userId, value: { textXp, textLevel, voiceXp, voiceLevel, lastMessageTimestamp }

function getUserData(userId) {
  if (!xpData.has(userId)) {
    xpData.set(userId, {
      textXp: 0,
      textLevel: 1,
      voiceXp: 0,
      voiceLevel: 1,
      lastMessageTimestamp: 0,
      coins: 0,
      lastDaily: 0,
      lastTrabalhar: 0,
      lastPescar: 0,
      lastRoubar: 0
    });
  }
  return xpData.get(userId);
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

// type: "text" ou "voice" — cada um tem seu próprio XP/nível
function addXp(userId, amount, type) {
  const data = getUserData(userId);
  const xpKey = type === "voice" ? "voiceXp" : "textXp";
  const levelKey = type === "voice" ? "voiceLevel" : "textLevel";

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
  7: "1546574924448141484",   // ex: Membro Ativo
  15: "1552496174882234479",  // ex: Veterano
  25: "1552497344270958674"   // ex: Lenda do Servidor
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
const TRABALHAR_COOLDOWN_MS = 60 * 60 * 1000;
const PESCAR_COOLDOWN_MS = 30 * 60 * 1000;
const ROUBAR_COOLDOWN_MS = 2 * 60 * 60 * 1000;

function formatarMoedas(valor) {
  return `${valor} 🪙`;
}

// =========================
// LOJA
// =========================
// Coloque aqui os itens que dá pra comprar com moedas.
// roleId é opcional — se preencher, o item concede um cargo cosmético ao comprar.
const SHOP_ITEMS = {
  destaque: {
    nome: "cargo membro VIP 👑",
    preco: 3500,
    roleId: "1371849692974944357" // ex: cargo de cor especial
  },
  vip: {
    nome: "Cargo pirata 🏴‍☠️",
    preco: 4500,
    roleId: "1530739542733230251"
  }
};

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
    .setName("embed")
    .setDescription("Cria um anúncio bonito em embed (staff).")
    .addStringOption(option =>
      option.setName("titulo").setDescription("Título do embed").setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("descricao")
        .setDescription("Texto do embed (use \\n pra quebrar linha)")
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("cor")
        .setDescription("Cor em hexadecimal, ex: #ff0000")
        .setRequired(false)
    )
    .addChannelOption(option =>
      option
        .setName("canal")
        .setDescription("Canal onde vai ser postado (padrão: este canal)")
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName("carteira")
    .setDescription("Mostra quantas moedas você (ou alguém) tem.")
    .addUserOption(option =>
      option.setName("usuario").setDescription("Usuário para ver a carteira").setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("daily")
    .setDescription("Resgata sua recompensa diária de moedas."),

  new SlashCommandBuilder()
    .setName("trabalhar")
    .setDescription("Faz um trampo e ganha uma moedinha certa."),

  new SlashCommandBuilder()
    .setName("pescar")
    .setDescription("Vai pescar e pode voltar com uma grana (ou não)."),

  new SlashCommandBuilder()
    .setName("roubar")
    .setDescription("Tenta roubar moedas de alguém. Corre o risco de dar errado.")
    .addUserOption(option =>
      option.setName("usuario").setDescription("Quem você vai tentar roubar").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("loja")
    .setDescription("Mostra os itens disponíveis pra comprar com moedas."),

  new SlashCommandBuilder()
    .setName("comprar")
    .setDescription("Compra um item da loja.")
    .addStringOption(option =>
      option
        .setName("item")
        .setDescription("Item que você quer comprar")
        .setRequired(true)
        .addChoices(
          ...Object.entries(SHOP_ITEMS).map(([id, item]) => ({
            name: `${item.nome} (${item.preco} 🪙)`,
            value: id
          }))
        )
    ),

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
    .setName("jogos")
    .setDescription("Mostra os próximos jogos do Brasileirão e da Seleção.")

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
// Usa a API-Football (v3.football.api-sports.io). Plano grátis: 100 requisições/dia.
// Precisa criar conta em https://dashboard.api-football.com e colocar a chave
// na variável de ambiente API_FOOTBALL_KEY no Render.
const FOOTBALL_API_BASE = "https://v3.football.api-sports.io";

// IDs "de fallback" (mais usados publicamente). O bot tenta confirmar/corrigir
// esses IDs sozinho ao iniciar, então não precisa mexer aqui normalmente.
// Cobre: Série A, Série B, Copa do Brasil, Libertadores e Sul-Americana + Seleção.
const LIGAS_BRASIL = {
  serieA: { id: 71, nome: "Serie A", country: "Brazil" },
  serieB: { id: 72, nome: "Serie B", country: "Brazil" },
  copaDoBrasil: { id: 73, nome: "Copa do Brazil", country: "Brazil" },
  libertadores: { id: 13, nome: "Libertadores", country: null },
  sulAmericana: { id: 11, nome: "Sudamericana", country: null }
};
let SELECAO_TEAM_ID = 6; // Seleção Brasileira

let futebolChannelId = null;
// Com 5 competições + Seleção (6 chamadas por checagem), a cada 2h dá 72 chamadas/dia,
// dentro do limite grátis de 100/dia da API-Football.
const FOOTBALL_CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000;
const FOOTBALL_REMINDER_WINDOW_MIN = 150; // cobre com folga o intervalo de checagem
const avisosEnviados = new Set();   // fixture.id que já recebeu o aviso de "tá quase começando"
const resultadosEnviados = new Set(); // fixture.id que já recebeu o resultado final

// Cache curto pro /jogos, pra não gastar a cota da API se várias pessoas usarem seguido
let jogosCache = { timestamp: 0, dados: null };
const JOGOS_CACHE_MS = 10 * 60 * 1000;

async function footballApiFetch(endpoint, params) {
  const url = new URL(`${FOOTBALL_API_BASE}${endpoint}`);
  Object.entries(params || {}).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });

  const response = await fetch(url, {
    headers: { "x-apisports-key": FOOTBALL_API_KEY }
  });

  if (!response.ok) {
    throw new Error(`API-Football respondeu ${response.status}`);
  }

  return response.json();
}

// Confirma os IDs certos de cada competição e da Seleção (pra não depender só do fallback)
async function descobrirIdsFutebol() {
  if (!FOOTBALL_API_KEY) return;

  for (const chave of Object.keys(LIGAS_BRASIL)) {
    const liga = LIGAS_BRASIL[chave];
    try {
      const params = { name: liga.nome };
      if (liga.country) params.country = liga.country;

      const ligas = await footballApiFetch("/leagues", params);
      if (ligas?.response?.length) {
        liga.id = ligas.response[0].league.id;
      }
    } catch (error) {
      console.error(`❌ Erro ao descobrir liga "${liga.nome}":`, error.message);
    }
  }

  try {
    const times = await footballApiFetch("/teams", { name: "Brazil" });
    const selecao = times?.response?.find(t => t.team.national === true);
    if (selecao) {
      SELECAO_TEAM_ID = selecao.team.id;
    }
  } catch (error) {
    console.error("❌ Erro ao descobrir time da Seleção:", error.message);
  }

  const resumo = Object.entries(LIGAS_BRASIL)
    .map(([chave, liga]) => `${chave}=${liga.id}`)
    .join(", ");
  console.log(`⚽ Competições: ${resumo} | Seleção: ${SELECAO_TEAM_ID}`);
}

// Acha o canal #futebol, ou cria se não existir
async function ensureFutebolChannel(guild) {
  let channel = guild.channels.cache.find(
    c => c.name === "futebol" && c.type === ChannelType.GuildText
  );

  if (!channel) {
    try {
      channel = await guild.channels.create({
        name: "futebol",
        type: ChannelType.GuildText,
        topic: "⚽ Avisos automáticos do Brasileirão e da Seleção Brasileira"
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

function formatarHorarioJogo(dataISO) {
  const timestamp = Math.floor(new Date(dataISO).getTime() / 1000);
  return `<t:${timestamp}:F> (<t:${timestamp}:R>)`;
}

async function checkFootball() {
  if (!FOOTBALL_API_KEY || !futebolChannelId) return;

  const channel = client.channels.cache.get(futebolChannelId);
  if (!channel) return;

  const hoje = new Date().toISOString().split("T")[0];
  const ano = new Date().getFullYear();

  try {
    const buscasLigas = Object.values(LIGAS_BRASIL).map(liga =>
      footballApiFetch("/fixtures", { league: liga.id, season: ano, date: hoje })
    );
    const buscaSelecao = footballApiFetch("/fixtures", { team: SELECAO_TEAM_ID, date: hoje });

    const resultados = await Promise.all([...buscasLigas, buscaSelecao]);

    const fixtures = resultados.flatMap(resultado => resultado?.response || []);

    const now = Date.now();

    for (const jogo of fixtures) {
      const fixtureId = jogo.fixture.id;
      const status = jogo.fixture.status.short;
      const kickoff = new Date(jogo.fixture.date).getTime();
      const minutosParaComecar = (kickoff - now) / 60000;

      const mandante = jogo.teams.home.name;
      const visitante = jogo.teams.away.name;
      const competicao = jogo.league.name;

      // Aviso de "tá quase começando"
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
            `🕐 ${formatarHorarioJogo(jogo.fixture.date)}`
          )
          .setColor(0x2ecc71);

        channel.send({ embeds: [embed] }).catch(() => {});
      }

      // Resultado final
      if (
        ["FT", "AET", "PEN"].includes(status) &&
        !resultadosEnviados.has(fixtureId)
      ) {
        resultadosEnviados.add(fixtureId);

        const golsMandante = jogo.goals.home;
        const golsVisitante = jogo.goals.away;

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

  if (FOOTBALL_API_KEY) {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (guild) {
      const canal = await ensureFutebolChannel(guild);
      if (canal) futebolChannelId = canal.id;
    }

    await descobrirIdsFutebol();
    setInterval(checkFootball, FOOTBALL_CHECK_INTERVAL_MS);
    checkFootball(); // já confere uma vez assim que liga
    console.log(`⚽ Avisos de futebol ativados (a cada ${FOOTBALL_CHECK_INTERVAL_MS / 60000} min)`);
  } else {
    console.log("⚠️ API_FOOTBALL_KEY não configurada — avisos de futebol desativados.");
  }
});

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
// INTERAÇÕES
// =========================
client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  console.log(`📥 Comando recebido: /${interaction.commandName}`);

  try {
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
        "**🤖 Bot Baguncinha — os corre que eu faço**\n\n" +
        "🏓 `/ping` — Confere se eu tô on e rapidão.\n" +
        "❓ `/help` — Essa mensagem aqui.\n" +
        "🖼️ `/avatar` — Manda a foto de alguém em HD.\n" +
        "👤 `/userinfo` — Perfil completo da pessoa.\n" +
        "🏠 `/serverinfo` — Os dados da nossa quebrada.\n" +
        "🧹 `/clear` — Zera as mensagem (só staff).\n" +
        "⏰ `/lembrete` — Te dou um toque na hora certa.\n" +
        "📊 `/perfil` — Teu nível e XP no servidor.\n" +
        "🏆 `/rank` — Quem tá mandando mais nessa porra.\n" +
        "📢 `/embed` — Cria um anúncio bonito (staff).\n" +
        "💰 `/carteira` — Vê quantas moedas você tem.\n" +
        "🎁 `/daily` — Recompensa diária de moedas.\n" +
        "💼 `/trabalhar` — Faz um trampo por moedas.\n" +
        "🎣 `/pescar` — Pesca por moedas (risco de dar zica).\n" +
        "🕵️ `/roubar` — Tenta roubar moedas de alguém.\n" +
        "🛒 `/loja` — Vê os itens pra comprar com moedas.\n" +
        "🛍️ `/comprar` — Compra um item da loja.\n" +
        "🪙 `/apostar` — Aposta suas moedas em cara ou coroa.\n" +
        "⚽ `/jogos` — Próximos jogos (Série A, B, Copa do Brasil, Libertadores, Sul-Americana e Seleção)."
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
          { name: "Fundada em", value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>` }
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
        `🧹 Pronto, sumi com ${deleted.size} mensagem(ns) dessa porra.`
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
        `⏰ Fechou! Te dou um toque em **${minutos} minuto(s)**: "${mensagem}"`
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
      const ranking = [...xpData.entries()]
        .sort((a, b) => {
          const totalA = getTotalLevel(a[1]);
          const totalB = getTotalLevel(b[1]);
          if (totalB !== totalA) return totalB - totalA;
          return (b[1].textXp + b[1].voiceXp) - (a[1].textXp + a[1].voiceXp);
        })
        .slice(0, 10);

      if (ranking.length === 0) {
        await interaction.reply("Ainda não rolou nada por aqui. Manda umas mensagens ou entra numa call!");
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

        return (
          `${posicao} **${nome}** — Nível ${getTotalLevel(data)}\n` +
          `　　💬 Texto: ${data.textLevel}  •  🎙️ Voz: ${data.voiceLevel}`
        );
      });

      const embed = new EmbedBuilder()
        .setTitle("🏆 Ranking dessa porra")
        .setDescription(linhas.join("\n\n"))
        .setColor(0xfee75c)
        .setThumbnail(usuarios[0]?.displayAvatarURL({ size: 256 }) || null)
        .setFooter({ text: `Top ${ranking.length} de atividade no servidor` });

      await interaction.reply({ embeds: [embed] });
      console.log("✅ /rank respondido");
      return;
    }

    // =========================
    // EMBED (STAFF)
    // =========================
    if (interaction.commandName === "embed") {
      const titulo = interaction.options.getString("titulo");
      const descricao = interaction.options.getString("descricao").replace(/\\n/g, "\n");
      const corInput = interaction.options.getString("cor");
      const canal = interaction.options.getChannel("canal") || interaction.channel;

      let cor = 0x5865f2;
      if (corInput) {
        const hex = corInput.replace("#", "");
        if (/^[0-9a-fA-F]{6}$/.test(hex)) {
          cor = parseInt(hex, 16);
        }
      }

      const embed = new EmbedBuilder()
        .setTitle(titulo)
        .setDescription(descricao)
        .setColor(cor)
        .setFooter({ text: `Postado por ${interaction.user.username}` });

      try {
        await canal.send({ embeds: [embed] });
        await interaction.reply({ content: `✅ Anúncio postado em ${canal}.`, ephemeral: true });
      } catch (error) {
        console.error("❌ Erro ao postar embed:", error);
        await interaction.reply({
          content: "❌ Não consegui postar nesse canal. Confere se eu tenho permissão lá.",
          ephemeral: true
        });
      }
      console.log("✅ /embed respondido");
      return;
    }

    // =========================
    // CARTEIRA
    // =========================
    if (interaction.commandName === "carteira") {
      const user = interaction.options.getUser("usuario") || interaction.user;
      const data = getUserData(user.id);

      await interaction.reply(
        `💰 A carteira de **${user.username}** tá com ${formatarMoedas(data.coins)}.`
      );
      console.log("✅ /carteira respondido");
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

      const ganho = Math.floor(Math.random() * 151) + 100; // 100 a 250
      data.coins += ganho;
      data.lastDaily = now;

      await interaction.reply(`🎁 Você resgatou seu daily e ganhou ${formatarMoedas(ganho)}!`);
      console.log("✅ /daily respondido");
      return;
    }

    // =========================
    // TRABALHAR
    // =========================
    if (interaction.commandName === "trabalhar") {
      const data = getUserData(interaction.user.id);
      const now = Date.now();

      if (now - data.lastTrabalhar < TRABALHAR_COOLDOWN_MS) {
        const restante = TRABALHAR_COOLDOWN_MS - (now - data.lastTrabalhar);
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
        "trabalhou de flanelinha"
      ];
      const trampo = TRAMPOS[Math.floor(Math.random() * TRAMPOS.length)];
      const ganho = Math.floor(Math.random() * 81) + 50; // 50 a 130

      data.coins += ganho;
      data.lastTrabalhar = now;

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
        await interaction.reply("🎣 Você ficou horas na beira do rio e não fisgou nada. Sorte no próximo.");
        console.log("✅ /pescar respondido (nada)");
        return;
      }

      const ganho = Math.floor(Math.random() * 91) + 20; // 20 a 110
      data.coins += ganho;

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
        await interaction.reply({ content: "❌ Não dá pra roubar de si mesmo, cria.", ephemeral: true });
        return;
      }
      if (alvo.bot) {
        await interaction.reply({ content: "❌ Bot não anda com dinheiro, esquece.", ephemeral: true });
        return;
      }

      const ladrao = getUserData(interaction.user.id);
      const vitima = getUserData(alvo.id);
      const now = Date.now();

      if (now - ladrao.lastRoubar < ROUBAR_COOLDOWN_MS) {
        const restante = ROUBAR_COOLDOWN_MS - (now - ladrao.lastRoubar);
        const minutos = Math.ceil(restante / (60 * 1000));
        await interaction.reply({
          content: `⏳ Tá muito na cara, espera uns ~${minutos} min antes de tentar de novo.`,
          ephemeral: true
        });
        return;
      }

      if (vitima.coins < 50) {
        await interaction.reply({
          content: `❌ ${alvo.username} tá quebrado, não vale nem a pena tentar.`,
          ephemeral: true
        });
        return;
      }

      ladrao.lastRoubar = now;

      const sucesso = Math.random() < 0.4; // 40% de chance de dar certo

      if (sucesso) {
        const percentual = Math.random() * 0.2 + 0.1; // rouba 10% a 30%
        const roubado = Math.max(1, Math.floor(vitima.coins * percentual));

        vitima.coins -= roubado;
        ladrao.coins += roubado;

        await interaction.reply(
          `🕵️ Deu certo! Você roubou ${formatarMoedas(roubado)} de ${alvo.username}.`
        );
      } else {
        const multa = Math.floor(Math.random() * 51) + 30; // perde 30 a 80
        ladrao.coins = Math.max(0, ladrao.coins - multa);

        await interaction.reply(
          `🚨 Foi pego tentando roubar ${alvo.username} e pagou uma multa de ${formatarMoedas(multa)}.`
        );
      }

      console.log("✅ /roubar respondido");
      return;
    }

    // =========================
    // LOJA
    // =========================
    if (interaction.commandName === "loja") {
      const linhas = Object.entries(SHOP_ITEMS).map(
        ([id, item]) => `**${item.nome}** — ${formatarMoedas(item.preco)}\nUse \`/comprar item:${item.nome}\``
      );

      const embed = new EmbedBuilder()
        .setTitle("🛒 Loja da quebrada")
        .setDescription(linhas.join("\n\n"))
        .setColor(0x9b59b6);

      await interaction.reply({ embeds: [embed] });
      console.log("✅ /loja respondido");
      return;
    }

    // =========================
    // COMPRAR
    // =========================
    if (interaction.commandName === "comprar") {
      const itemId = interaction.options.getString("item");
      const item = SHOP_ITEMS[itemId];

      if (!item) {
        await interaction.reply({ content: "❌ Esse item não existe.", ephemeral: true });
        return;
      }

      const data = getUserData(interaction.user.id);

      if (data.coins < item.preco) {
        await interaction.reply({
          content: `❌ Faltam ${formatarMoedas(item.preco - data.coins)} pra comprar **${item.nome}**.`,
          ephemeral: true
        });
        return;
      }

      data.coins -= item.preco;

      if (item.roleId && !item.roleId.startsWith("COLOQUE_")) {
        try {
          const member = await interaction.guild.members.fetch(interaction.user.id);
          await member.roles.add(item.roleId);
        } catch (error) {
          console.error("❌ Erro ao dar cargo da loja:", error);
        }
      }

      await interaction.reply(`✅ Você comprou **${item.nome}**! Aproveita.`);
      console.log("✅ /comprar respondido");
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
        await interaction.reply(
          `🪙 Deu **${resultado}**! Você dobrou a aposta e ganhou ${formatarMoedas(quantidade)}.`
        );
      } else {
        data.coins -= quantidade;
        await interaction.reply(
          `🪙 Deu **${resultado}**... você perdeu ${formatarMoedas(quantidade)}. Próxima.`
        );
      }

      console.log("✅ /apostar respondido");
      return;
    }

    // =========================
    // JOGOS (BRASILEIRÃO + SELEÇÃO)
    // =========================
    if (interaction.commandName === "jogos") {
      if (!FOOTBALL_API_KEY) {
        await interaction.reply({
          content: "❌ Os avisos de futebol ainda não tão configurados (falta a chave da API).",
          ephemeral: true
        });
        return;
      }

      await interaction.deferReply();

      try {
        let fixtures;

        if (jogosCache.dados && Date.now() - jogosCache.timestamp < JOGOS_CACHE_MS) {
          fixtures = jogosCache.dados;
        } else {
          const ano = new Date().getFullYear();

          const buscasLigas = Object.values(LIGAS_BRASIL).map(liga =>
            footballApiFetch("/fixtures", { league: liga.id, season: ano, next: 3 })
          );
          const buscaSelecao = footballApiFetch("/fixtures", { team: SELECAO_TEAM_ID, next: 3 });

          const resultados = await Promise.all([...buscasLigas, buscaSelecao]);

          fixtures = resultados
            .flatMap(resultado => resultado?.response || [])
            .sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));

          jogosCache = { timestamp: Date.now(), dados: fixtures };
        }

        if (fixtures.length === 0) {
          await interaction.editReply("Não achei nenhum jogo marcado por enquanto.");
          return;
        }

        const linhas = fixtures
          .slice(0, 12)
          .map(jogo => {
            return (
              `⚽ **${jogo.teams.home.name} x ${jogo.teams.away.name}**\n` +
              `　　🏆 ${jogo.league.name} — 🕐 ${formatarHorarioJogo(jogo.fixture.date)}`
            );
          });

        const embed = new EmbedBuilder()
          .setTitle("📅 Próximos jogos")
          .setDescription(linhas.join("\n\n"))
          .setColor(0x2ecc71);

        await interaction.editReply({ embeds: [embed] });
      } catch (error) {
        console.error("❌ Erro ao buscar jogos:", error);
        await interaction.editReply("❌ Deu ruim buscando os jogos. Tenta de novo mais tarde.");
      }

      console.log("✅ /jogos respondido");
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
// SERVIDOR HTTP — RENDER
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

    await registerCommands();

    console.log("🔌 Conectando ao Discord...");
    await client.login(TOKEN);
  } catch (error) {
    console.error("❌ ERRO AO INICIAR O BOT:");
    console.error(error);
  }
}

start();
