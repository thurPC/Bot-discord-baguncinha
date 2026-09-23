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
    GatewayIntentBits.Guilds
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
// REGISTRAR COMANDOS
// =========================

async function registerCommands() {
  try {
    console.log("🔄 Registrando comandos...");

    const rest = new REST({
      version: "10"
    }).setToken(TOKEN);

    await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      {
        body: commands
      }
    );

    console.log("✅ Comandos registrados!");
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

      await interaction.reply({
        content: `🏓 Pong!\nLatência: **${client.ws.ping}ms**`,
        ephemeral: false
      });

      console.log("✅ /ping respondido");
      return;
    }

    // =========================
    // HELP
    // =========================

    if (interaction.commandName === "help") {

      await interaction.reply({
        content:
          "**🤖 Bot Baguncinha — Comandos**\n\n" +
          "🏓 `/ping` — Mostra a latência do bot.\n" +
          "❓ `/help` — Mostra esta mensagem.",
        ephemeral: false
      });

      console.log("✅ /help respondido");
      return;
    }

    // =========================
    // COMANDO DESCONHECIDO
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
