const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits
} = require("discord.js");
const http = require("http");

// =========================
// CONFIGURAÇÃO
// =========================
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = "1370256381701128192";
const PORT = process.env.PORT || 10000;

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
    GatewayIntentBits.MessageContent
  ]
});

// =========================
// "BANCO DE DADOS" EM MEMÓRIA (XP)
// ⚠️ Isso zera toda vez que o bot reinicia.
// Pra persistir de verdade, depois dá pra trocar por um arquivo JSON ou um banco (SQLite/Supabase).
// =========================
const xpData = new Map(); // key: userId, value: { xp, level, lastMessageTimestamp }

function getUserData(userId) {
  if (!xpData.has(userId)) {
    xpData.set(userId, { xp: 0, level: 1, lastMessageTimestamp: 0 });
  }
  return xpData.get(userId);
}

function xpForNextLevel(level) {
  return level * 100;
}

function addXp(userId, amount) {
  const data = getUserData(userId);
  data.xp += amount;

  let leveledUp = false;
  while (data.xp >= xpForNextLevel(data.level)) {
    data.xp -= xpForNextLevel(data.level);
    data.level += 1;
    leveledUp = true;
  }

  return { data, leveledUp };
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
        .setDescription("Em quantos minutos te avisar")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(1440)
    )
    .addStringOption(option =>
      option
        .setName("mensagem")
        .setDescription("O que você quer ser lembrado")
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
    .setDescription("Mostra o ranking de XP do servidor (top 10).")

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
// BOT CONECTADO
// =========================
client.once("ready", () => {
  console.log("=================================");
  console.log(`🤖 Bot conectado como ${client.user.tag}`);
  console.log(`🆔 ID: ${client.user.id}`);
  console.log(`🌐 Servidores: ${client.guilds.cache.size}`);
  console.log("=================================");
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
  const { leveledUp, data: updated } = addXp(message.author.id, xpGained);

  if (leveledUp) {
    message.channel
      .send(`🎉 Parabéns ${message.author}, você subiu para o **nível ${updated.level}**!`)
      .catch(() => {});
  }
});

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
        `🏓 Pong!\nLatência: **${client.ws.ping}ms**`
      );
      console.log("✅ /ping respondido");
      return;
    }

    // =========================
    // HELP
    // =========================
    if (interaction.commandName === "help") {
      await interaction.reply(
        "**🤖 Bot Baguncinha — Comandos**\n\n" +
        "🏓 `/ping` — Mostra a latência do bot.\n" +
        "❓ `/help` — Mostra esta mensagem.\n" +
        "🖼️ `/avatar` — Mostra o avatar de alguém.\n" +
        "👤 `/userinfo` — Informações de um membro.\n" +
        "🏠 `/serverinfo` — Informações do servidor.\n" +
        "🧹 `/clear` — Apaga mensagens (moderação).\n" +
        "⏰ `/lembrete` — Cria um lembrete.\n" +
        "📊 `/perfil` — Mostra seu nível e XP.\n" +
        "🏆 `/rank` — Ranking de XP do servidor."
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
        .setTitle(`Avatar de ${user.username}`)
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
        .setTitle(`Informações de ${user.username}`)
        .setThumbnail(user.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: "ID", value: user.id, inline: true },
          { name: "Apelido", value: member.nickname || "Nenhum", inline: true },
          { name: "Cargos", value: `${member.roles.cache.size - 1}`, inline: true },
          { name: "Entrou no servidor", value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` },
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
        .setTitle(`Informações de ${guild.name}`)
        .setThumbnail(guild.iconURL({ size: 256 }) || null)
        .addFields(
          { name: "Membros", value: `${guild.memberCount}`, inline: true },
          { name: "Cargos", value: `${guild.roles.cache.size}`, inline: true },
          { name: "Canais", value: `${guild.channels.cache.size}`, inline: true },
          { name: "Criado em", value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>` }
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
        `🧹 ${deleted.size} mensagem(ns) apagada(s) com sucesso.`
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
        `⏰ Ok! Vou te lembrar em **${minutos} minuto(s)**: "${mensagem}"`
      );

      setTimeout(() => {
        interaction.followUp(
          `🔔 ${interaction.user}, lembrete: **${mensagem}**`
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
      const proximoNivel = xpForNextLevel(data.level);

      const embed = new EmbedBuilder()
        .setTitle(`Perfil de ${user.username}`)
        .setThumbnail(user.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: "Nível", value: `${data.level}`, inline: true },
          { name: "XP", value: `${data.xp} / ${proximoNivel}`, inline: true }
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
          if (b[1].level !== a[1].level) return b[1].level - a[1].level;
          return b[1].xp - a[1].xp;
        })
        .slice(0, 10);

      if (ranking.length === 0) {
        await interaction.reply("Ainda não há dados de XP registrados. Manda umas mensagens aí!");
        return;
      }

      const linhas = await Promise.all(
        ranking.map(async ([userId, data], index) => {
          const user = await client.users.fetch(userId).catch(() => null);
          const nome = user ? user.username : `Usuário ${userId}`;
          return `**${index + 1}.** ${nome} — Nível ${data.level} (${data.xp} XP)`;
        })
      );

      const embed = new EmbedBuilder()
        .setTitle("🏆 Ranking do Servidor")
        .setDescription(linhas.join("\n"))
        .setColor(0xfee75c);

      await interaction.reply({ embeds: [embed] });
      console.log("✅ /rank respondido");
      return;
    }

    // =========================
    // DESCONHECIDO
    // =========================
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "❌ Esse comando ainda não está configurado.",
        ephemeral: true
      });
    }

  } catch (error) {
    console.error("❌ ERRO AO RESPONDER INTERAÇÃO:");
    console.error(error);

    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({
          content: "❌ Ocorreu um erro ao executar esse comando.",
          ephemeral: true
        });
      } else {
        await interaction.reply({
          content: "❌ Ocorreu um erro ao executar esse comando.",
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
  res.end("🤖 Bot Baguncinha online!");
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
