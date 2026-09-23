const { Client, GatewayIntentBits } = require("discord.js");
const http = require("http");

const TOKEN = process.env.TOKEN;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds
  ]
});

const PORT = process.env.PORT || 10000;

http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/plain"
  });

  res.end("Bot Baguncinha online!");
}).listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 HTTP funcionando na porta ${PORT}`);
});

client.once("ready", () => {
  console.log(`🤖 BOT CONECTADO: ${client.user.tag}`);
  console.log(`🌐 Servidores: ${client.guilds.cache.size}`);
});

client.on("error", error => {
  console.error("❌ Discord Client Error:", error);
});

client.login(TOKEN)
  .then(() => {
    console.log("🔑 Login realizado com sucesso!");
  })
  .catch(error => {
    console.error("❌ ERRO NO LOGIN:", error);
  });
