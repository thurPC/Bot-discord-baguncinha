const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder
} = require("discord.js");

const http = require("http");

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds
  ]
});

const commands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Mostra a latência do bot."),

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Mostra os comandos disponíveis.")
].map(command => command.toJSON());

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

client.once("ready", () => {
  console.log(`🤖 Bot conectado como ${client.user.tag}`);
  console.log(`🌐 Servidores: ${client.guilds.cache.size}`);
});

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
        "`/help` — Mostra esta mensagem."
      );
    }
  } catch (error) {
    console.error("❌ Erro ao responder comando:", error);
  }
});

const PORT = process.env.PORT || 10000;

http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/plain"
  });

  res.end("Bot Baguncinha online!");
}).listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Servidor HTTP rodando na porta ${PORT}`);
});

async function start() {
  await registerCommands();

  console.log("🔑 Conectando ao Discord...");

  await client.login(TOKEN);
}

start().catch(error => {
  console.error("❌ Erro ao iniciar o bot:", error);
});
