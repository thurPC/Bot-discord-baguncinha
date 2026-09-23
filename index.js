const {
  Client,
  GatewayIntentBits
} = require("discord.js");

const http = require("http");

const TOKEN = process.env.TOKEN;

// =========================
// CLIENTE DO DISCORD
// =========================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds
  ]
});

// =========================
// BOT ONLINE
// =========================

client.once("ready", () => {
  console.log(`🤖 Bot conectado como ${client.user.tag}`);
  console.log(`🌐 Servidores: ${client.guilds.cache.size}`);
});

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
      return;
    }

    if (interaction.commandName === "help") {
      await interaction.reply(
        "**🤖 Comandos disponíveis:**\n\n" +
        "`/ping` — Mostra a latência do bot.\n" +
        "`/help` — Mostra esta mensagem."
      );
      return;
    }

  } catch (error) {
    console.error("❌ Erro ao responder comando:", error);

    if (!interaction.replied && !interaction.deferred) {
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

http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/plain"
  });

  res.end("Bot Baguncinha online!");
}).listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Servidor HTTP rodando na porta ${PORT}`);
});

// =========================
// LOGIN
// =========================

if (!TOKEN) {
  console.log("❌ TOKEN não configurado.");
} else {
  console.log("🔑 Conectando ao Discord...");

  client.login(TOKEN).catch(error => {
    console.error("❌ Erro ao conectar ao Discord:", error);
  });
}
