const { Client, GatewayIntentBits } = require("discord.js");
const http = require("http");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds
  ]
});

// Servidor HTTP necessário para o Render
const PORT = process.env.PORT || 10000;

http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot Baguncinha online!");
}).listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor HTTP rodando na porta ${PORT}`);
});

client.once("ready", () => {
  console.log(`Bot conectado como ${client.user.tag}`);
});

client.login(process.env.TOKEN);
