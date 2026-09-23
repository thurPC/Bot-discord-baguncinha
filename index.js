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
const GUILD_ID = "1370256381701128192";

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
// REGISTRAR COMANDOS NO SERVIDOR
// =========================

async function registerCommands() {
  if (!TOKEN || !CLIENT_ID) {
    console.log("❌ TOKEN ou CLIENT_ID não configurado.");
    return;
  }

  const rest = new REST({ version: "10" }).setToken(TOKEN);

  try {
    console.log("🔄 Registrando comandos no servidor...");

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
    console.error("❌ Erro ao registrar comandos:", error);
  }
}

// =========================
// IDENTIFICAR JOGO
// =========================

function getGameFromPresence(presence) {
  if (!presence || !presence.activities) {
    return null;
  }

  for (const activity of presence.activities) {
    if (!activity.name) continue;

    const game = activity.name.toLowerCase();

    if (game.includes("valorant")) {
      return "valorant";
    }

    if (game.includes("minecraft")) {
      return "minecraft";
    }

    if (
      game.includes("fivem") ||
      game.includes("five m")
    ) {
      return "fivem";
    }
  }

  return null;
}

// =========================
// CARGOS DOS JOGOS
// =========================

const GAME_ROLES = {
  valorant: "Valorant",
  minecraft: "Minecraft",
  fivem: "FiveM"
};

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

    const shouldHaveRole =
      game && GAME_ROLES[game] === roleName;

    try {
      if (shouldHaveRole) {
        if (!member.roles.cache.has(role.id)) {
          await member.roles.add(role);

          console.log(
            `🎮 ${member.user.tag} recebeu ${roleName}`
          );
        }
      } else {
        if (member.roles.cache.has(role.id)) {
          await member.roles.remove(role);

          console.log(
            `🗑️ ${member.user.tag} perdeu ${roleName}`
          );
        }
      }
    } catch (error) {
      console.error(
        `❌ Erro com o cargo ${roleName}:`,
        error
      );
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
// ATUALIZAÇÃO DE PRESENÇA
// =========================

client.on(
  "presenceUpdate",
  async (oldPresence, newPresence) => {
    try {
      if (!newPresence || !newPresence.member) {
        return;
      }

      const member = newPresence.member;

      if (member.user.bot) return;

      const game = getGameFromPresence(newPresence);

      await updateGameRoles(member, game);
    } catch (error) {
      console.error(
        "❌ Erro no sistema de cargos:",
        error
      );
    }
  }
);

// =========================
// COMANDOS
// =========================

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
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
  } catch (error) {
    console.error(
      "❌ Erro ao responder comando:",
      error
    );

    if (!interaction.replied) {
      await interaction.reply({
        content: "❌ Ocorreu um erro ao executar o comando.",
        ephemeral: true
      });
    }
  }
});

// =========================
// SERVIDOR HTTP — RENDER
// =========================

const PORT = process.env.PORT || 10000;

http
  .createServer((req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/plain"
    });

    res.end("Bot Baguncinha online!");
  })
  .listen(PORT, "0.0.0.0", () => {
    console.log(
      `🌐 Servidor HTTP rodando na porta ${PORT}`
    );
  });

// =========================
// INICIAR BOT
// =========================

async function start() {
  await registerCommands();

  console.log("🔑 Conectando ao Discord...");

  await client.login(TOKEN);
}

start().catch(error => {
  console.error("❌ Erro ao iniciar o bot:", error);
});
