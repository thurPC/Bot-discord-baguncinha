const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder
} = require("discord.js");

const http = require("http");

// =========================
// CONFIGURAÇÃO
// =========================

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

// =========================
// CLIENTE DO DISCORD
// =========================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences
  ]
});

// =========================
// JOGOS E CARGOS
// =========================

const GAME_ROLES = {
  valorant: "Valorant",
  minecraft: "Minecraft",
  fivem: "FiveM"
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
    .setDescription("Mostra os comandos disponíveis.")
].map(command => command.toJSON());

// =========================
// REGISTRAR COMANDOS
// =========================

async function registerCommands() {
  if (!TOKEN || !CLIENT_ID) {
    console.log("❌ TOKEN ou CLIENT_ID não configurado.");
    return;
  }

  const rest = new REST({ version: "10" }).setToken(TOKEN);

  try {
    console.log("🔄 Registrando comandos...");

    await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      {
        body: commands
      }
    );

    console.log("✅ Comandos registrados!");
  } catch (error) {
    console.error("❌ Erro ao registrar comandos:", error);
  }
}

// =========================
// ENCONTRAR JOGO
// =========================

function getGameFromPresence(presence) {
  if (!presence || !presence.activities) {
    return null;
  }

  for (const activity of presence.activities) {
    if (!activity.name) continue;

    const gameName = activity.name.toLowerCase();

    if (gameName.includes("valorant")) {
      return "valorant";
    }

    if (
      gameName.includes("minecraft") ||
      gameName.includes("minecraft launcher")
    ) {
      return "minecraft";
    }

    if (
      gameName.includes("fivem") ||
      gameName.includes("five m")
    ) {
      return "fivem";
    }
  }

  return null;
}

// =========================
// CRIAR / ENCONTRAR CARGO
// =========================

async function getOrCreateRole(guild, roleName) {
  let role = guild.roles.cache.find(
    r => r.name.toLowerCase() === roleName.toLowerCase()
  );

  if (role) {
    return role;
  }

  try {
    role = await guild.roles.create({
      name: roleName,
      reason: "Cargo automático de atividade do Baguncinha"
    });

    console.log(`✅ Cargo criado: ${roleName}`);

    return role;
  } catch (error) {
    console.error(`❌ Não consegui criar o cargo ${roleName}:`, error);
    return null;
  }
}

// =========================
// ATUALIZAR CARGOS
// =========================

async function updateGameRoles(member, game) {
  if (!member || member.user.bot) return;

  for (const roleName of Object.values(GAME_ROLES)) {
    const role = member.guild.roles.cache.find(
      r => r.name.toLowerCase() === roleName.toLowerCase()
    );

    if (!role) continue;

    // Se o usuário está jogando este jogo
    if (GAME_ROLES[game] === roleName) {
      if (!member.roles.cache.has(role.id)) {
        try {
          await member.roles.add(role);

          console.log(
            `🎮 ${member.user.tag} recebeu o cargo ${roleName}`
          );
        } catch (error) {
          console.error(
            `❌ Erro ao adicionar ${roleName}:`,
            error
          );
        }
      }
    }

    // Remove os outros cargos de jogo
    else {
      if (member.roles.cache.has(role.id)) {
        try {
          await member.roles.remove(role);

          console.log(
            `🗑️ ${member.user.tag} perdeu o cargo ${roleName}`
          );
        } catch (error) {
          console.error(
            `❌ Erro ao remover ${roleName}:`,
            error
          );
        }
      }
    }
  }
}

// =========================
// BOT ONLINE
// =========================

client.once("ready", () => {
  console.log(`🤖 Bot conectado como ${client.user.tag}`);
  console.log(`🌐 Servidores: ${client.guilds.cache.size}`);
});

// =========================
// MUDANÇA DE ATIVIDADE
// =========================

client.on("presenceUpdate", async (oldPresence, newPresence) => {
  try {
    if (!newPresence || !newPresence.member) return;

    const member = newPresence.member;

    if (member.user.bot) return;

    const game = getGameFromPresence(newPresence);

    await updateGameRoles(member, game);
  } catch (error) {
    console.error("❌ Erro no sistema de cargos:", error);
  }
});

// =========================
// INTERAÇÕES
// =========================

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "ping") {
    await interaction.reply(
      `🏓 Pong! Latência: ${client.ws.ping}ms`
    );
  }

  if (interaction.commandName === "help") {
    await interaction.reply(
      "**🤖 Comandos disponíveis:**\n\n" +
      "`/ping` — Mostra a latência do bot.\n" +
      "`/help` — Mostra esta mensagem.\n\n" +
      "**🎮 Cargos automáticos:**\n" +
      "🎯 Valorant\n" +
      "⛏️ Minecraft\n" +
      "🚗 FiveM"
    );
  }
});

// =========================
// SERVIDOR HTTP — RENDER
// =========================

const PORT = process.env.PORT || 10000;

http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/plain"
  });

  res.end("Bot Baguncinha online!");
}).listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Servidor HTTP rodando na porta ${PORT}`);
});

// =========================
// INICIALIZAÇÃO
// =========================

async function start() {
  await registerCommands();

  client.login(TOKEN);
}

start();
