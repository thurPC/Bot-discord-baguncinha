const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require("discord.js");
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
// REGISTRO DOS COMANDOS
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
      { body: commands }
    );

    console.log("✅ Comandos registrados!");
  } catch (error) {
    console.error("❌ Erro ao registrar comandos:", error);
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
      "`/help` — Mostra esta mensagem."
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
