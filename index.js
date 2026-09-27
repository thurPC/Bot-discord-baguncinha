const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  Partials
} = require("discord.js");
const http = require("http");
const fs = require("fs");
const path = require("path");

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
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// =========================
// "BANCO DE DADOS" EM MEMÓRIA (XP)
// ⚠️ Isso zera toda vez que o bot reinicia.
// Pra persistir de verdade, depois dá pra trocar por um arquivo JSON ou um banco (SQLite/Supabase).
// =========================
// XP de texto e de voz são contados separadamente (níveis independentes),
// mas os dois somam pro "nível total", que é o que libera os cargos por atividade.
const xpData = new Map(); // key: userId, value: { textXp, textLevel, voiceXp, voiceLevel, lastMessageTimestamp }

// =========================
// PERSISTÊNCIA EM JSON
// =========================
// ⚠️ O disco do Render é temporário: sobrevive a "dormir e acordar", mas
// some quando você faz um novo deploy (o container é recriado do zero).
const DATA_FILE = path.join(__dirname, "database.json");

function carregarDados() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const bruto = fs.readFileSync(DATA_FILE, "utf-8");
      const objeto = JSON.parse(bruto);

      for (const [userId, dadosUsuario] of Object.entries(objeto)) {
        xpData.set(userId, dadosUsuario);
      }

      console.log(`💾 Banco de dados carregado (${xpData.size} usuário(s)).`);
    } else {
      console.log("💾 Nenhum banco de dados encontrado, começando do zero.");
    }
  } catch (error) {
    console.error("❌ Erro ao carregar banco de dados:", error);
  }
}

function salvarDados() {
  try {
    const objeto = Object.fromEntries(xpData);
    fs.writeFileSync(DATA_FILE, JSON.stringify(objeto, null, 2));
  } catch (error) {
    console.error("❌ Erro ao salvar banco de dados:", error);
  }
}

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
      lastRoubar: 0,
      lastRoleta: 0,           // cooldown da /roleta
      presoAte: 0,             // timestamp — enquanto Date.now() < isso, tá "preso" (roubo malsucedido)
      turboTrabalhar: false,   // true depois de comprar o item que reduz o cooldown do /trabalhar
      xpBoostAte: 0,           // timestamp — enquanto Date.now() < isso, XP em dobro
      ticketsSorteio: 0,       // quantos bilhetes de sorteio a pessoa tem
      conquistas: [],          // ids de conquistas já desbloqueadas
      itemLendario: false      // flag de quem já tirou o prêmio raro da caixa/roleta
    });
  }

  // Compatibilidade: quem já tinha conta antes dessa atualização não tem esses campos
  const data = xpData.get(userId);
  if (data.lastRoleta === undefined) data.lastRoleta = 0;
  if (data.presoAte === undefined) data.presoAte = 0;
  if (data.turboTrabalhar === undefined) data.turboTrabalhar = false;
  if (data.xpBoostAte === undefined) data.xpBoostAte = 0;
  if (data.ticketsSorteio === undefined) data.ticketsSorteio = 0;
  if (data.conquistas === undefined) data.conquistas = [];
  if (data.itemLendario === undefined) data.itemLendario = false;

  return data;
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

  // XP Boost da loja: dobra o ganho enquanto estiver ativo
  if (Date.now() < data.xpBoostAte) {
    amount *= 2;
  }

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
const TRABALHAR_COOLDOWN_NORMAL_MS = 60 * 60 * 1000;
const TRABALHAR_COOLDOWN_TURBO_MS = 25 * 60 * 1000; // com o item "Turbo Trabalhar" da loja
const PESCAR_COOLDOWN_MS = 8 * 60 * 1000;
const ROUBAR_COOLDOWN_MS = 20 * 60 * 1000;
const ROUBAR_PRISAO_MS = 15 * 60 * 1000; // tempo preso quando o roubo dá errado
const ROLETA_COOLDOWN_MS = 1 * 60 * 1000;
const ROLETA_APOSTA_MIN = 100;
const ROLETA_APOSTA_MAX = 5000;
const PPT_APOSTA_MIN = 50;
const PPT_APOSTA_MAX = 5000;

function getTrabalharCooldown(data) {
  return data.turboTrabalhar ? TRABALHAR_COOLDOWN_TURBO_MS : TRABALHAR_COOLDOWN_NORMAL_MS;
}

// Quanto tempo ainda falta pra pessoa sair da prisão (0 se já não tá presa)
function getPrisaoRestante(data) {
  const restante = data.presoAte - Date.now();
  return restante > 0 ? restante : 0;
}

function formatarMoedas(valor) {
  return `${valor} 🪙`;
}

// =========================
// META DE MOEDAS DO SERVIDOR (10k, 20k, 30k...)
// =========================
// Cada meta (10.000, 20.000, 30.000...) só é anunciada e recompensada UMA VEZ pra
// todo o servidor: a primeira pessoa a alcançar aquele total leva o prêmio, e as
// metas já batidas ficam salvas num arquivo à parte pra sobreviver a reinícios.
const METAS_FILE = path.join(__dirname, "metas.json");
const METAS_TIER_MS = 10000; // de 10 em 10 mil moedas
const metasBatidas = new Set(); // valores de meta (10000, 20000, ...) já anunciados

function carregarMetas() {
  try {
    if (fs.existsSync(METAS_FILE)) {
      const bruto = fs.readFileSync(METAS_FILE, "utf-8");
      const lista = JSON.parse(bruto);
      lista.forEach(valor => metasBatidas.add(valor));
      console.log(`🏁 Metas de moedas carregadas (${metasBatidas.size} já batida(s)).`);
    }
  } catch (error) {
    console.error("❌ Erro ao carregar metas de moedas:", error);
  }
}

function salvarMetas() {
  try {
    fs.writeFileSync(METAS_FILE, JSON.stringify([...metasBatidas], null, 2));
  } catch (error) {
    console.error("❌ Erro ao salvar metas de moedas:", error);
  }
}

// 10k -> 1.000 / 20k -> 4.000 / 30k -> 7.000 / 40k -> 10.000 ... (+3.000 a cada meta)
function calcularRecompensaMeta(meta) {
  const tier = meta / METAS_TIER_MS;
  return 1000 + (tier - 1) * 3000;
}

// Confere se o saldo atual cruzou alguma meta nova de 10 em 10 mil. Se sim, dá a
// recompensa e anuncia no canal onde o comando foi usado — mas só pra quem chega
// primeiro em cada meta; quem chega depois não ganha nem gera novo anúncio.
async function verificarMetaMoedas(canal, userId, data) {
  const metaAtingivel = Math.floor(data.coins / METAS_TIER_MS) * METAS_TIER_MS;
  if (metaAtingivel < METAS_TIER_MS) return;

  for (let meta = METAS_TIER_MS; meta <= metaAtingivel; meta += METAS_TIER_MS) {
    if (metasBatidas.has(meta)) continue;

    metasBatidas.add(meta);
    salvarMetas();

    const recompensa = calcularRecompensaMeta(meta);
    data.coins += recompensa;

    if (canal) {
      canal
        .send(
          `🏁 **META DO SERVIDOR BATIDA!**\n` +
          `<@${userId}> foi a primeira pessoa a passar de **${meta.toLocaleString("pt-BR")} 🪙** no servidor!\n` +
          `🎁 Recompensa: ${formatarMoedas(recompensa)}`
        )
        .catch(() => {});
    }
  }
}

// =========================
// BAGUNCINHA STORE
// =========================
// Categorias e itens da loja. Preencha os "COLOQUE_..." com IDs reais de cargo
// quando for usar. tipo decide o que acontece na hora da compra:
//   "cargo"            -> dá um cargo cosmético
//   "turbo_trabalhar"  -> reduz o cooldown do /trabalhar pra sempre
//   "xp_boost"         -> dobra XP por 1h
//   "caixa"            -> abre uma caixa misteriosa com prêmio aleatório
//   "ticket"           -> dá 1 bilhete pro sorteio
const LOJA_CATEGORIAS = {
  boosts: { nome: "⚡ Boosts", descricao: "Vantagens permanentes ou temporárias." },
  cargos: { nome: "👑 Cargos", descricao: "Cargos cosméticos pra se destacar." },
  caixas: { nome: "📦 Caixas Misteriosas", descricao: "Aposta na sorte por uma recompensa aleatória." },
  bilhetes: { nome: "🎫 Sorteio", descricao: "Bilhetes pra concorrer a prêmios do servidor." }
};

const LOJA_ITEMS = {
  turbo_trabalhar: {
    categoria: "boosts",
    nome: "⏱️ Turbo Trabalhar",
    preco: 3000,
    descricao: "Reduz o tempo do `/trabalhar` de 60 pra 25 minutos. Permanente.",
    tipo: "turbo_trabalhar"
  },
  xp_boost: {
    categoria: "boosts",
    nome: "✨ XP Boost (2x por 1h)",
    preco: 1500,
    descricao: "Dobra o XP ganho (texto e voz) pela próxima 1 hora.",
    tipo: "xp_boost"
  },
  cargo_vip: {
    categoria: "cargos",
    nome: "👑 Cargo VIP",
    preco: 3500,
    descricao: "Cargo cosmético de destaque no servidor.",
    tipo: "cargo",
    roleId: "1371849692974944357"
  },
  cargo_pirata: {
    categoria: "cargos",
    nome: "🏴‍☠️ Cargo Pirata",
    preco: 4500,
    descricao: "Pra quem tá on pela zoeira.",
    tipo: "cargo",
    roleId: "1530739542733230251"
  },
  cargo_neon: {
    categoria: "cargos",
    nome: " Cargo Neon",
    preco: 6000,
    descricao: "Cor de nome mais legal do servidor.",
    tipo: "cargo",
    roleId: "COLOQUE_O_ID_DO_CARGO_NEON_AQUI"
  },
  caixa_baguncinha: {
    categoria: "caixas",
    nome: "📦 Caixa baguncinha",
    preco: 2000,
    descricao: "Pode vir moedas, XP Boost, cargo temporário ou até item lendário.",
    tipo: "caixa"
  },
  ticket_sorteio: {
    categoria: "bilhetes",
    nome: "🎫 Ticket de Sorteio",
    preco: 500,
    descricao: "1 bilhete = 1 chance no próximo sorteio (staff usa `/sortear`).",
    tipo: "ticket"
  }
};

// =========================
// CAIXA MISTERIOSA — TABELA DE RARIDADE
// =========================
// "peso" define a chance (peso maior = mais comum). Soma dos pesos = 100.
// EV calibrado pra ficar abaixo do preço da caixa (2.000), mantendo a economia saudável.
const CARGO_TEMPORARIO_ID = "COLOQUE_O_ID_DO_CARGO_TEMPORARIO_AQUI"; // cargo de 24h, prêmio ÉPICO
const CAIXA_REWARDS = [
  { raridade: "COMUM", peso: 40, tipo: "moedas", valor: 500 },
  { raridade: "COMUM", peso: 25, tipo: "moedas", valor: 1000 },
  { raridade: "RARO", peso: 15, tipo: "moedas", valor: 3000 },
  { raridade: "RARO", peso: 10, tipo: "xp_boost", valor: null },
  { raridade: "ÉPICO", peso: 6, tipo: "cargo_temporario", valor: null },
  { raridade: "LENDÁRIO", peso: 3, tipo: "moedas", valor: 8000 },
  { raridade: "???", peso: 1, tipo: "jackpot", valor: 20000 }
];

const CORES_RARIDADE = {
  "COMUM": 0x95a5a6,
  "RARO": 0x3498db,
  "ÉPICO": 0x9b59b6,
  "LENDÁRIO": 0xf1c40f,
  "???": 0xe74c3c
};

function sortearRecompensaCaixa() {
  const totalPeso = CAIXA_REWARDS.reduce((soma, item) => soma + item.peso, 0);
  let sorteio = Math.random() * totalPeso;

  for (const recompensa of CAIXA_REWARDS) {
    if (sorteio < recompensa.peso) return recompensa;
    sorteio -= recompensa.peso;
  }

  return CAIXA_REWARDS[0]; // fallback, nunca deveria chegar aqui
}

async function aplicarRecompensaCaixa(member, data, recompensa) {
  let descricao = "";

  if (recompensa.tipo === "moedas") {
    data.coins += recompensa.valor;
    descricao = `Você ganhou ${formatarMoedas(recompensa.valor)}!`;
  } else if (recompensa.tipo === "xp_boost") {
    const agora = Date.now();
    data.xpBoostAte = Math.max(data.xpBoostAte, agora) + 60 * 60 * 1000;
    descricao = "Você ganhou **XP Boost 2x por 1 hora**!";
  } else if (recompensa.tipo === "cargo_temporario") {
    if (CARGO_TEMPORARIO_ID.startsWith("COLOQUE_")) {
      data.coins += 1000;
      descricao = "Você ganharia um cargo temporário, mas ele ainda não foi configurado — ganhou 1.000 🪙 no lugar.";
    } else {
      await member.roles.add(CARGO_TEMPORARIO_ID).catch(() => {});
      setTimeout(() => {
        member.roles.remove(CARGO_TEMPORARIO_ID).catch(() => {});
      }, 24 * 60 * 60 * 1000);
      descricao = "Você ganhou um **cargo temporário por 24 horas**!";
    }
  } else if (recompensa.tipo === "jackpot") {
    data.coins += recompensa.valor;
    data.itemLendario = true;
    descricao = `🎉 **JACKPOT SECRETO!** Você ganhou ${formatarMoedas(recompensa.valor)} e desbloqueou o item lendário místico!`;
  }

  return descricao;
}

// =========================
// ROLETA BAGUNCINHA
// =========================
// Pesos calibrados pra deixar uma leve vantagem da casa (EV ~0.95x da aposta),
// senão a roleta vira fonte infinita de moedas em vez de minigame.
const ROLETA_RESULTADOS = [
  { label: "❌ 0x — PERDEU TUDO", multiplicador: 0, peso: 35 },
  { label: " 0.5x — Quase lá", multiplicador: 0.5, peso: 25 },
  { label: " 1x — Empatou", multiplicador: 1, peso: 20 },
  { label: "🎉 2x — Dobrou!", multiplicador: 2, peso: 14 },
  { label: "🔥 5x — Grande vitória!", multiplicador: 5, peso: 5 },
  { label: "💎 JACKPOT 10X!!! 💎", multiplicador: 10, peso: 1 }
];

function sortearRoleta() {
  const totalPeso = ROLETA_RESULTADOS.reduce((soma, item) => soma + item.peso, 0);
  let sorteio = Math.random() * totalPeso;

  for (const resultado of ROLETA_RESULTADOS) {
    if (sorteio < resultado.peso) return resultado;
    sorteio -= resultado.peso;
  }

  return ROLETA_RESULTADOS[0];
}

// =========================
// CONQUISTAS
// =========================
// Cada conquista tem uma condição pra checar e uma recompensa. O usuário
// roda /conquistas pra reivindicar as que já cumpriu — não é dado automático,
// assim a pessoa volta a interagir com o bot em vez de só ganhar tudo passivo.
const CONQUISTAS = {
  veterano: {
    nome: "🏆 Veterano",
    descricao: "Fique 30 dias no servidor.",
    condicao: member => Date.now() - member.joinedTimestamp >= 30 * 24 * 60 * 60 * 1000,
    moedas: 5000,
    roleId: "COLOQUE_O_ID_DO_CARGO_VETERANO_AQUI",
    badge: "🎖️ Badge Veterano"
  }
};

async function verificarConquistas(member, data) {
  const desbloqueadas = [];

  for (const [id, conquista] of Object.entries(CONQUISTAS)) {
    if (data.conquistas.includes(id)) continue;
    if (!conquista.condicao(member)) continue;

    data.conquistas.push(id);
    data.coins += conquista.moedas;

    if (conquista.roleId && !conquista.roleId.startsWith("COLOQUE_")) {
      await member.roles.add(conquista.roleId).catch(() => {});
    }

    desbloqueadas.push(conquista);
  }

  return desbloqueadas;
}

// =========================
// UI DA LOJA (EMBED + BOTÕES)
// =========================
function montarEmbedLojaPrincipal() {
  return new EmbedBuilder()
    .setTitle("🎪 BAGUNCINHA STORE")
    .setDescription(
      "Escolha uma categoria no menu abaixo pra ver os itens.\n\n" +
      Object.values(LOJA_CATEGORIAS).map(c => `${c.nome} — ${c.descricao}`).join("\n") +
      "\n\n🏆 Tem conquistas te esperando também — dá uma olhada no `/conquistas`."
    )
    .setColor(0x9b59b6)
    .setFooter({ text: "Baguncinha Store" });
}

function montarComponentesLojaPrincipal() {
  const linhaCategoria = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("loja_categoria")
      .setPlaceholder("📂 Escolher categoria")
      .addOptions(
        Object.entries(LOJA_CATEGORIAS).map(([id, cat]) => ({
          label: cat.nome,
          description: cat.descricao,
          value: id
        }))
      )
  );

  return [linhaCategoria];
}

function montarEmbedLojaCategoria(categoriaId) {
  const categoria = LOJA_CATEGORIAS[categoriaId];
  const itensCategoria = Object.entries(LOJA_ITEMS).filter(([, item]) => item.categoria === categoriaId);

  return new EmbedBuilder()
    .setTitle(`${categoria.nome} — BAGUNCINHA STORE`)
    .setDescription(
      itensCategoria
        .map(([, item]) => `**${item.nome}** — ${formatarMoedas(item.preco)}\n${item.descricao}`)
        .join("\n\n")
    )
    .setColor(0x9b59b6)
    .setFooter({ text: "Baguncinha Store" });
}

function montarComponentesLojaCategoria(categoriaId) {
  const itensCategoria = Object.entries(LOJA_ITEMS).filter(([, item]) => item.categoria === categoriaId);

  const linhasItens = [];
  let linhaAtual = new ActionRowBuilder();

  itensCategoria.forEach(([id, item], index) => {
    if (index > 0 && index % 4 === 0) {
      linhasItens.push(linhaAtual);
      linhaAtual = new ActionRowBuilder();
    }
    linhaAtual.addComponents(
      new ButtonBuilder()
        .setCustomId(`loja_comprar_${id}`)
        .setLabel(`${item.nome} — ${item.preco}🪙`)
        .setStyle(ButtonStyle.Primary)
    );
  });

  if (linhaAtual.components.length > 0) linhasItens.push(linhaAtual);

  const linhaVoltar = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("loja_voltar").setLabel("⬅️ Categorias").setStyle(ButtonStyle.Secondary)
  );

  return [...linhasItens, linhaVoltar];
}

async function comprarItem(interaction, itemId) {
  const item = LOJA_ITEMS[itemId];

  if (!item) {
    await interaction.reply({ content: "❌ Esse item não existe.", ephemeral: true });
    return;
  }

  const data = getUserData(interaction.user.id);

  if (item.tipo === "turbo_trabalhar" && data.turboTrabalhar) {
    await interaction.reply({ content: "❌ Você já tem o Turbo Trabalhar ativo.", ephemeral: true });
    return;
  }

  if (data.coins < item.preco) {
    await interaction.reply({
      content: `❌ Faltam ${formatarMoedas(item.preco - data.coins)} pra comprar **${item.nome}**.`,
      ephemeral: true
    });
    return;
  }

  data.coins -= item.preco;

  if (item.tipo === "caixa") {
    const recompensa = sortearRecompensaCaixa();
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    const descricaoPremio = await aplicarRecompensaCaixa(member, data, recompensa);

    await verificarMetaMoedas(interaction.channel, interaction.user.id, data);

    const embed = new EmbedBuilder()
      .setTitle(`📦 ${item.nome} — ${recompensa.raridade}`)
      .setDescription(descricaoPremio)
      .setColor(CORES_RARIDADE[recompensa.raridade] || 0x9b59b6);

    salvarDados();
    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  if (item.tipo === "ticket") {
    data.ticketsSorteio += 1;
    salvarDados();
    await interaction.reply({
      content: `🎫 Você comprou 1 ticket de sorteio! Total: **${data.ticketsSorteio}**.`,
      ephemeral: true
    });
    return;
  }

  if (item.tipo === "turbo_trabalhar") {
    data.turboTrabalhar = true;
    salvarDados();
    await interaction.reply({
      content: "✅ Comprado! Seu cooldown do `/trabalhar` agora é de **25 minutos**.",
      ephemeral: true
    });
    return;
  }

  if (item.tipo === "xp_boost") {
    const agora = Date.now();
    data.xpBoostAte = Math.max(data.xpBoostAte, agora) + 60 * 60 * 1000;
    salvarDados();
    await interaction.reply({ content: "✅ **XP Boost 2x** ativado por 1 hora!", ephemeral: true });
    return;
  }

  if (item.tipo === "cargo") {
    if (item.roleId.startsWith("COLOQUE_")) {
      data.coins += item.preco;
      await interaction.reply({
        content: "❌ Esse cargo ainda não foi configurado pelo admin. Nada foi cobrado.",
        ephemeral: true
      });
      return;
    }

    try {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      await member.roles.add(item.roleId);
    } catch (error) {
      console.error("❌ Erro ao dar cargo da loja:", error);
    }

    salvarDados();
    await interaction.reply({ content: `✅ Você comprou **${item.nome}**! Aproveita.`, ephemeral: true });
    return;
  }
}

async function handleLojaInteraction(interaction) {
  if (interaction.isStringSelectMenu() && interaction.customId === "loja_categoria") {
    const categoriaId = interaction.values[0];
    await interaction.update({
      embeds: [montarEmbedLojaCategoria(categoriaId)],
      components: montarComponentesLojaCategoria(categoriaId)
    });
    return;
  }

  if (interaction.isButton() && interaction.customId === "loja_voltar") {
    await interaction.update({
      embeds: [montarEmbedLojaPrincipal()],
      components: montarComponentesLojaPrincipal()
    });
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("loja_comprar_")) {
    const itemId = interaction.customId.replace("loja_comprar_", "");
    await comprarItem(interaction, itemId);
    return;
  }
}

// =========================
// PEDRA, PAPEL OU TESOURA (APOSTA ENTRE USUÁRIOS)
// =========================
const pptMatches = new Map(); // matchId -> { desafianteId, desafiadoId, aposta, status, escolhas }
const PPT_OPCOES = { pedra: "🪨 Pedra", papel: "📄 Papel", tesoura: "✂️ Tesoura" };

function resolverPpt(escolhaA, escolhaB) {
  if (escolhaA === escolhaB) return "empate";
  const vence = { pedra: "tesoura", papel: "pedra", tesoura: "papel" };
  return vence[escolhaA] === escolhaB ? "A" : "B";
}

async function handlePptInteraction(interaction) {
  const [, acao, matchId] = interaction.customId.split(":");
  const match = pptMatches.get(matchId);

  if (!match) {
    await interaction.reply({ content: "❌ Esse desafio expirou ou não existe mais.", ephemeral: true });
    return;
  }

  if (acao === "aceitar" || acao === "recusar") {
    if (interaction.user.id !== match.desafiadoId) {
      await interaction.reply({ content: "❌ Esse desafio não é seu.", ephemeral: true });
      return;
    }

    if (acao === "recusar") {
      pptMatches.delete(matchId);
      await interaction.update({
        content: `❌ ${interaction.user} recusou o desafio.`,
        embeds: [],
        components: []
      });
      return;
    }

    const desafianteData = getUserData(match.desafianteId);
    const desafiadoData = getUserData(match.desafiadoId);

    if (desafianteData.coins < match.aposta || desafiadoData.coins < match.aposta) {
      pptMatches.delete(matchId);
      await interaction.update({
        content: "❌ Alguém não tem mais moedas suficientes pra essa aposta. Desafio cancelado.",
        embeds: [],
        components: []
      });
      return;
    }

    desafianteData.coins -= match.aposta;
    desafiadoData.coins -= match.aposta;
    match.status = "jogando";

    const linhaEscolhas = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ppt:escolha_pedra:${matchId}`).setLabel("🪨 Pedra").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`ppt:escolha_papel:${matchId}`).setLabel("📄 Papel").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`ppt:escolha_tesoura:${matchId}`).setLabel("✂️ Tesoura").setStyle(ButtonStyle.Secondary)
    );

    salvarDados();
    await interaction.update({
      content: `✅ Desafio aceito! Aposta de ${formatarMoedas(match.aposta)} cada.\nCliquem na escolha de vocês (só você vê sua própria confirmação).`,
      embeds: [],
      components: [linhaEscolhas]
    });
    return;
  }

  if (acao.startsWith("escolha_")) {
    if (match.status !== "jogando") {
      await interaction.reply({ content: "❌ Esse desafio ainda não começou ou já acabou.", ephemeral: true });
      return;
    }

    if (interaction.user.id !== match.desafianteId && interaction.user.id !== match.desafiadoId) {
      await interaction.reply({ content: "❌ Esse desafio não é seu.", ephemeral: true });
      return;
    }

    if (match.escolhas[interaction.user.id]) {
      await interaction.reply({ content: "❌ Você já escolheu.", ephemeral: true });
      return;
    }

    const escolha = acao.replace("escolha_", "");
    match.escolhas[interaction.user.id] = escolha;

    await interaction.reply({
      content: `✅ Você escolheu ${PPT_OPCOES[escolha]}. Aguardando o adversário...`,
      ephemeral: true
    });

    const escolhaA = match.escolhas[match.desafianteId];
    const escolhaB = match.escolhas[match.desafiadoId];

    if (!escolhaA || !escolhaB) return;

    const desafianteData = getUserData(match.desafianteId);
    const desafiadoData = getUserData(match.desafiadoId);
    const resultado = resolverPpt(escolhaA, escolhaB);

    let textoResultado;
    if (resultado === "empate") {
      desafianteData.coins += match.aposta;
      desafiadoData.coins += match.aposta;
      textoResultado = `🤝 Empate! ${PPT_OPCOES[escolhaA]} x ${PPT_OPCOES[escolhaB]}. Moedas devolvidas pros dois.`;
    } else if (resultado === "A") {
      desafianteData.coins += match.aposta * 2;
      textoResultado = `🏆 <@${match.desafianteId}> venceu! ${PPT_OPCOES[escolhaA]} bate ${PPT_OPCOES[escolhaB]}. Levou ${formatarMoedas(match.aposta * 2)}.`;
    } else {
      desafiadoData.coins += match.aposta * 2;
      textoResultado = `🏆 <@${match.desafiadoId}> venceu! ${PPT_OPCOES[escolhaB]} bate ${PPT_OPCOES[escolhaA]}. Levou ${formatarMoedas(match.aposta * 2)}.`;
    }

    await verificarMetaMoedas(interaction.channel, match.desafianteId, desafianteData);
    await verificarMetaMoedas(interaction.channel, match.desafiadoId, desafiadoData);

    pptMatches.delete(matchId);
    salvarDados();

    await interaction.message.edit({
      content: ` #Resultado do desafio\n${textoResultado}`,
      embeds: [],
      components: []
    }).catch(() => {});
    return;
  }
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
    .setName("rankmoedas")
    .setDescription("Mostra o ranking de quem tem mais moedas no servidor (top 10)."),

  new SlashCommandBuilder()
    .setName("embed")
    .setDescription("Abre um construtor interativo de embed (staff).")
    .addStringOption(option =>
      option.setName("titulo").setDescription("Título do embed").setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("descricao")
        .setDescription("Texto do embed (use \\n pra quebrar linha)")
        .setRequired(true)
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
    .setName("doar")
    .setDescription("Doa uma quantidade de moedas pra outra pessoa.")
    .addUserOption(option =>
      option.setName("usuario").setDescription("Quem vai receber as moedas").setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName("quantidade")
        .setDescription("Quantas moedas você quer doar")
        .setRequired(true)
        .setMinValue(1)
    ),

  new SlashCommandBuilder()
    .setName("loja")
    .setDescription("Abre a Baguncinha Store em embed com botões pra comprar."),

  new SlashCommandBuilder()
    .setName("comprar")
    .setDescription("Compra um item da loja direto por comando.")
    .addStringOption(option =>
      option
        .setName("item")
        .setDescription("Item que você quer comprar")
        .setRequired(true)
        .addChoices(
          ...Object.entries(LOJA_ITEMS).map(([id, item]) => ({
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
    .setName("roleta")
    .setDescription("Aposta moedas na Roleta Baguncinha.")
    .addIntegerOption(option =>
      option
        .setName("quantidade")
        .setDescription(`Quanto apostar (${ROLETA_APOSTA_MIN} a ${ROLETA_APOSTA_MAX})`)
        .setRequired(true)
        .setMinValue(ROLETA_APOSTA_MIN)
        .setMaxValue(ROLETA_APOSTA_MAX)
    ),

  new SlashCommandBuilder()
    .setName("ppt")
    .setDescription("Desafia alguém pra Pedra, Papel ou Tesoura apostando moedas.")
    .addUserOption(option =>
      option.setName("usuario").setDescription("Quem você desafia").setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName("quantidade")
        .setDescription(`Quanto apostar (${PPT_APOSTA_MIN} a ${PPT_APOSTA_MAX})`)
        .setRequired(true)
        .setMinValue(PPT_APOSTA_MIN)
        .setMaxValue(PPT_APOSTA_MAX)
    ),

  new SlashCommandBuilder()
    .setName("conquistas")
    .setDescription("Vê e reivindica suas conquistas do servidor."),

  new SlashCommandBuilder()
    .setName("jogos")
    .setDescription("Mostra os próximos jogos do Brasileirão e da Seleção."),

  new SlashCommandBuilder()
    .setName("editarmoedas")
    .setDescription("Adiciona, remove ou define as moedas de um usuário (admin).")
    .addUserOption(option =>
      option.setName("usuario").setDescription("Quem vai ter as moedas alteradas").setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("acao")
        .setDescription("O que fazer com as moedas")
        .setRequired(true)
        .addChoices(
          { name: "Adicionar", value: "adicionar" },
          { name: "Remover", value: "remover" },
          { name: "Definir (zera e coloca esse valor)", value: "definir" }
        )
    )
    .addIntegerOption(option =>
      option
        .setName("quantidade")
        .setDescription("Quantidade de moedas")
        .setRequired(true)
        .setMinValue(0)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("bloquearcanais")
    .setDescription("Bloqueia a visão de todos os canais pro cargo Não Verificado (roda uma vez, admin).")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

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
  copaDoBrasil: { id: 73, nome: "Copa do Brasil", country: "Brazil" },
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

  // Timeout de 10s — sem isso, se a rede travar, o fetch fica pendurado pra sempre
  // e a interação do Discord expira sem nenhum log de erro aparecer.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      headers: { "x-apisports-key": FOOTBALL_API_KEY },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`API-Football respondeu ${response.status}`);
    }

    return response.json();
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Tempo esgotado conectando na API-Football (10s)");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
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

  // A verificação é configurada ANTES do futebol de propósito: descobrirIdsFutebol()
  // faz várias chamadas de API que podem demorar (até 10s de timeout cada). Se a
  // verificação fosse configurada só depois, qualquer reação que chegasse nesse
  // meio-tempo seria ignorada porque verificacaoMessageId ainda estaria null.
  const guildVerificacao = client.guilds.cache.get(GUILD_ID);
  if (guildVerificacao && !NAO_VERIFICADO_ROLE_ID.startsWith("COLOQUE_")) {
    const canalVerificacao = await ensureVerificacaoChannel(guildVerificacao);
    if (canalVerificacao) {
      const mensagem = await ensureVerificacaoMessage(canalVerificacao);
      if (mensagem) {
        verificacaoMessageId = mensagem.id;
        console.log(`🔒 Sistema de verificação ativo (mensagem ${verificacaoMessageId}).`);
      } else {
        console.log("⚠️ Verificação NÃO ativa: não consegui criar/achar a mensagem de verificação.");
      }
    } else {
      console.log("⚠️ Verificação NÃO ativa: não consegui criar/achar o canal #verificacao.");
    }
  } else {
    console.log("⚠️ NAO_VERIFICADO_ROLE_ID não configurado — verificação desativada.");
  }

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
// VERIFICAÇÃO POR REAÇÃO — PORTÃO DE ENTRADA
// =========================
// Novo membro ganha o cargo "Não Verificado" e só enxerga o canal de verificação
// (isso você configura nas permissões dos canais).
// Quando reage na mensagem fixa com os emojis, ganha o(s) cargo(s) de interesse
// e perde o "Não Verificado", liberando o resto do servidor.
const NAO_VERIFICADO_ROLE_ID = "1552496115566252082";

// A chave usada aqui precisa ser IDÊNTICA à chave em INTEREST_ROLES lá embaixo.
const INTEREST_EMOJIS = {
  "🎯": "valorant",
  "⛏️": "minecraft",
  "🔫": "cs",
  "🧱": "roblox",
  "💬": "geral"
};

const VERIFICACAO_MARCADOR = "verificacao-baguncinha";
let verificacaoMessageId = null;

// O Discord às vezes devolve o nome do emoji da reação SEM o "variation selector"
// (o caractere invisível U+FE0F que alguns emojis, tipo ⛏️, carregam). Se a chave em
// INTEREST_EMOJIS tiver o U+FE0F e a reação vier sem ele (ou vice-versa), o lookup
// direto falha e a verificação simplesmente não faz nada pra aquele emoji.
// normalizarEmoji() remove esse caractere dos dois lados antes de comparar.
function normalizarEmoji(nome) {
  return nome ? nome.replace(/\uFE0F/g, "") : nome;
}

const INTEREST_EMOJIS_NORMALIZADO = Object.fromEntries(
  Object.entries(INTEREST_EMOJIS).map(([emoji, interesse]) => [normalizarEmoji(emoji), interesse])
);

// Acha o canal #verificacao, ou cria se não existir
async function ensureVerificacaoChannel(guild) {
  let channel = guild.channels.cache.find(
    c => c.name === "verificacao" && c.type === ChannelType.GuildText
  );

  if (!channel) {
    try {
      channel = await guild.channels.create({
        name: "verificacao",
        type: ChannelType.GuildText,
        topic: "🔒 Reaja aqui pra liberar seu acesso ao servidor"
      });
      console.log("✅ Canal #verificacao criado.");
    } catch (error) {
      console.error("❌ Não consegui criar o canal #verificacao (confere a permissão 'Gerenciar Canais'):");
      console.error(error);
      return null;
    }
  }

  return channel;
}

// Acha a mensagem de verificação já existente, ou cria uma nova com as reações
async function ensureVerificacaoMessage(channel) {
  try {
    const mensagens = await channel.messages.fetch({ limit: 20 });
    const existente = mensagens.find(
      m => m.author.id === client.user.id && m.embeds[0]?.footer?.text === VERIFICACAO_MARCADOR
    );

    if (existente) {
      return existente;
    }

    const embed = new EmbedBuilder()
      .setTitle("🔒 Verificação de acesso")
      .setDescription(
        "Bem-vindo(a) à Baguncinha! Pra liberar o acesso ao resto do servidor, reage aqui embaixo " +
        "com o que você joga:\n\n" +
        "🎯 — Valorant\n⛏️ — Minecraft\n🔫 — CS\n🧱 — Roblox\n💬 — Geral (só bater papo mesmo)\n\n" +
        "Assim que reagir com pelo menos um, seu acesso já é liberado na hora."
      )
      .setColor(0x5865f2)
      .setFooter({ text: VERIFICACAO_MARCADOR });

    const mensagem = await channel.send({ embeds: [embed] });
    for (const emoji of Object.keys(INTEREST_EMOJIS)) {
      await mensagem.react(emoji);
    }

    return mensagem;
  } catch (error) {
    console.error("❌ Erro ao preparar mensagem de verificação:", error);
    return null;
  }
}

client.on("guildMemberAdd", async member => {
  if (member.user.bot) return;
  if (NAO_VERIFICADO_ROLE_ID.startsWith("COLOQUE_")) return; // ainda não configurado

  try {
    await member.roles.add(NAO_VERIFICADO_ROLE_ID);
    console.log(`🔒 ${member.user.tag} marcado como não verificado.`);
  } catch (error) {
    console.error("❌ Erro ao dar cargo de não verificado:", error);
  }
});

client.on("messageReactionAdd", async (reaction, user) => {
  if (user.bot) return;
  if (reaction.message.id !== verificacaoMessageId) return;

  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch {
      return;
    }
  }

  const interesse = INTEREST_EMOJIS_NORMALIZADO[normalizarEmoji(reaction.emoji.name)];
  if (!interesse) return;

  const guild = reaction.message.guild;
  const member = await guild.members.fetch(user.id).catch(error => {
    console.error("❌ Erro ao buscar membro pra verificação (confere se o 'Server Members Intent' tá ligado no Discord Developer Portal):", error.message);
    return null;
  });
  if (!member) return;

  const roleId = INTEREST_ROLES[interesse];
  if (roleId && !roleId.startsWith("COLOQUE_")) {
    await member.roles.add(roleId).catch(() => {});
  }

  if (!NAO_VERIFICADO_ROLE_ID.startsWith("COLOQUE_") && member.roles.cache.has(NAO_VERIFICADO_ROLE_ID)) {
    await member.roles.remove(NAO_VERIFICADO_ROLE_ID).catch(() => {});
    member.send("✅ Verificado! Já pode acessar o resto do servidor. Bem-vindo(a)!").catch(() => {});
    console.log(`✅ ${user.tag} verificado.`);
  }
});

client.on("messageReactionRemove", async (reaction, user) => {
  if (user.bot) return;
  if (reaction.message.id !== verificacaoMessageId) return;

  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch {
      return;
    }
  }

  const interesse = INTEREST_EMOJIS_NORMALIZADO[normalizarEmoji(reaction.emoji.name)];
  if (!interesse) return;

  const guild = reaction.message.guild;
  const member = await guild.members.fetch(user.id).catch(error => {
    console.error("❌ Erro ao buscar membro pra verificação (confere se o 'Server Members Intent' tá ligado no Discord Developer Portal):", error.message);
    return null;
  });
  if (!member) return;

  // Tira só o cargo de interesse — não bloqueia de novo o acesso já liberado
  const roleId = INTEREST_ROLES[interesse];
  if (roleId && !roleId.startsWith("COLOQUE_")) {
    await member.roles.remove(roleId).catch(() => {});
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
// CONSTRUTOR INTERATIVO DE /embed
// =========================
const embedDrafts = new Map(); // userId -> rascunho do embed em edição

const CORES_EMBED = {
  azul: { nome: "🔵 Azul", valor: 0x5865f2 },
  vermelho: { nome: "🔴 Vermelho", valor: 0xed4245 },
  verde: { nome: "🟢 Verde", valor: 0x57f287 },
  amarelo: { nome: "🟡 Amarelo", valor: 0xfee75c },
  roxo: { nome: "🟣 Roxo", valor: 0x9b59b6 },
  laranja: { nome: "🟠 Laranja", valor: 0xe67e22 },
  preto: { nome: "⚫ Preto", valor: 0x23272a },
  branco: { nome: "⚪ Branco", valor: 0xffffff },
  rosa: { nome: "🌸 Rosa", valor: 0xeb459e },
  aleatoria: { nome: "🎲 Aleatória (sorteia toda vez)", valor: null }
};

function urlValida(valor) {
  return typeof valor === "string" && /^https?:\/\//i.test(valor);
}

function montarPreviewEmbed(draft) {
  const cor = draft.cor === null ? Math.floor(Math.random() * 0xffffff) : draft.cor;

  const embed = new EmbedBuilder()
    .setTitle(draft.titulo)
    .setDescription(draft.descricao)
    .setColor(cor)
    .setFooter({ text: draft.footer || `Postado por ${draft.autorNome}` });

  if (draft.imagemUrl) embed.setImage(draft.imagemUrl);
  if (draft.linkTitulo) embed.setURL(draft.linkTitulo);

  return embed;
}

function montarComponentesEmbedBuilder() {
  const linhaCanal = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId("embedbuilder_canal")
      .setPlaceholder("📌 Escolher canal (padrão: este canal)")
      .addChannelTypes(ChannelType.GuildText)
  );

  const linhaCor = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("embedbuilder_cor")
      .setPlaceholder("🎨 Escolher cor")
      .addOptions(
        Object.entries(CORES_EMBED).map(([id, cor]) => ({
          label: cor.nome,
          value: id
        }))
      )
  );

  const linhaBotoes1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("embedbuilder_imagem").setLabel("🖼️ Imagem").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("embedbuilder_footer").setLabel("📌 Rodapé").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("embedbuilder_link").setLabel("🔗 Link do título").setStyle(ButtonStyle.Secondary)
  );

  const linhaBotoes2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("embedbuilder_publicar").setLabel("✅ Publicar").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("embedbuilder_cancelar").setLabel("❌ Cancelar").setStyle(ButtonStyle.Danger)
  );

  return [linhaCanal, linhaCor, linhaBotoes1, linhaBotoes2];
}

async function handleEmbedBuilderInteraction(interaction) {
  const userId = interaction.user.id;
  const draft = embedDrafts.get(userId);

  if (!draft) {
    const resposta = { content: "❌ Essa sessão de embed expirou. Roda `/embed` de novo.", ephemeral: true };
    if (interaction.isModalSubmit() || interaction.isMessageComponent()) {
      await interaction.reply(resposta).catch(() => {});
    }
    return;
  }

  // Botões que abrem um modal (imagem, rodapé, link)
  if (interaction.isButton() && ["embedbuilder_imagem", "embedbuilder_footer", "embedbuilder_link"].includes(interaction.customId)) {
    const campoMap = {
      embedbuilder_imagem: {
        customId: "embedbuilder_modal_imagem",
        titulo: "Link da imagem",
        label: "URL da imagem (vazio = remover)",
        valorAtual: draft.imagemUrl || ""
      },
      embedbuilder_footer: {
        customId: "embedbuilder_modal_footer",
        titulo: "Rodapé do embed",
        label: "Texto do rodapé (vazio = remover)",
        valorAtual: draft.footer || ""
      },
      embedbuilder_link: {
        customId: "embedbuilder_modal_link",
        titulo: "Link do título",
        label: "URL que o título vai abrir (vazio = remover)",
        valorAtual: draft.linkTitulo || ""
      }
    };

    const campo = campoMap[interaction.customId];

    const modal = new ModalBuilder().setCustomId(campo.customId).setTitle(campo.titulo);
    const input = new TextInputBuilder()
      .setCustomId("valor")
      .setLabel(campo.label)
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setValue(campo.valorAtual);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
    return;
  }

  // Seleção de cor
  if (interaction.isStringSelectMenu() && interaction.customId === "embedbuilder_cor") {
    draft.cor = CORES_EMBED[interaction.values[0]].valor;
    await interaction.update({ embeds: [montarPreviewEmbed(draft)], components: montarComponentesEmbedBuilder() });
    return;
  }

  // Seleção de canal
  if (interaction.isChannelSelectMenu() && interaction.customId === "embedbuilder_canal") {
    draft.canalId = interaction.values[0];
    await interaction.update({ embeds: [montarPreviewEmbed(draft)], components: montarComponentesEmbedBuilder() });
    return;
  }

  // Publicar
  if (interaction.isButton() && interaction.customId === "embedbuilder_publicar") {
    const canal = draft.canalId
      ? await interaction.guild.channels.fetch(draft.canalId).catch(() => null)
      : interaction.channel;

    if (!canal) {
      await interaction.reply({ content: "❌ Não achei o canal escolhido.", ephemeral: true });
      return;
    }

    try {
      await canal.send({ embeds: [montarPreviewEmbed(draft)] });
      embedDrafts.delete(userId);
      await interaction.update({ content: `✅ Anúncio postado em ${canal}.`, embeds: [], components: [] });
    } catch (error) {
      console.error("❌ Erro ao publicar embed:", error);
      await interaction.reply({
        content: "❌ Não consegui postar nesse canal. Confere se eu tenho permissão lá.",
        ephemeral: true
      });
    }
    return;
  }

  // Cancelar
  if (interaction.isButton() && interaction.customId === "embedbuilder_cancelar") {
    embedDrafts.delete(userId);
    await interaction.update({ content: "❌ Cancelado.", embeds: [], components: [] });
    return;
  }

  // Retorno dos modais (imagem, rodapé, link)
  if (interaction.isModalSubmit()) {
    const valor = interaction.fields.getTextInputValue("valor").trim();

    if (interaction.customId === "embedbuilder_modal_imagem") {
      draft.imagemUrl = urlValida(valor) ? valor : null;
    } else if (interaction.customId === "embedbuilder_modal_footer") {
      draft.footer = valor || null;
    } else if (interaction.customId === "embedbuilder_modal_link") {
      draft.linkTitulo = urlValida(valor) ? valor : null;
    }

    await interaction.update({ embeds: [montarPreviewEmbed(draft)], components: montarComponentesEmbedBuilder() });
    return;
  }
}

// =========================
// INTERAÇÕES
// =========================
client.on("interactionCreate", async interaction => {
  // Componentes/modais do construtor de /embed (não são slash commands)
  if (interaction.customId && interaction.customId.startsWith("embedbuilder_")) {
    await handleEmbedBuilderInteraction(interaction);
    return;
  }

  // Componentes da Baguncinha Store
  if (interaction.customId && interaction.customId.startsWith("loja_")) {
    await handleLojaInteraction(interaction);
    return;
  }

  // Componentes do Pedra, Papel ou Tesoura
  if (interaction.customId && interaction.customId.startsWith("ppt:")) {
    await handlePptInteraction(interaction);
    return;
  }

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
        "**🤖 Bot Baguncinha — oq posso fazer no server**\n\n" +
        "🏓 `/ping` — Confere se eu tô on e suave.\n" +
        "❓ `/help` — mostra todos os comandos.\n" +
        "🖼️ `/avatar` — Manda a foto de alguém em HD.\n" +
        "👤 `/userinfo` — Perfil completo da pessoa.\n" +
        "🏠 `/serverinfo` — Os dados da nossa quebrada.\n" +
        "🧹 `/clear` — Zera as mensagem (só staff).\n" +
        "⏰ `/lembrete` — Te dou um toque na hora certa.\n" +
        "📊 `/perfil` — Teu nível e XP no servidor.\n" +
        "🏆 `/rank` — Quem tá mandando mais no server todo.\n" +
        "💰 `/rankmoedas` — Ranking de quem tem mais moedas no servidor.\n" +
        "📢 `/embed` — Cria um anúncio bonito (só staff).\n" +
        "💰 `/carteira` — Vê quantas moedas você tem.\n" +
        "🎁 `/daily` — Recompensa diária de moedas.\n" +
        "💼 `/trabalhar` — Faz um trampo por moedas.\n" +
        "🎣 `/pescar` — Pesca por moedas (risco de dar red).\n" +
        "🕵️ `/roubar` — Tenta roubar moedas de alguém (pode se dar mal e ir preso).\n" +
        "🤝 `/doar` — Doa moedas pra outra pessoa.\n" +
        "🎪 `/loja` — Abre a Baguncinha Store em embed com botões.\n" +
        "🛍️ `/comprar` — Compra um item da loja direto por comando.\n" +
        "🪙 `/apostar` — Aposta suas moedas em cara ou coroa.\n" +
        "🎰 `/roleta` — Aposta moedas na Roleta Baguncinha.\n" +
        "🪨 `/ppt` — Desafia alguém pra Pedra, Papel ou Tesoura apostando moedas.\n" +
        "🏆 `/conquistas` — Vê e reivindica suas conquistas do servidor.\n"
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
          { name: "Fundado em", value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>` }
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
        `🧹 Pronto, sumi com essas ${deleted.size} mensagem(ns) meu parceiro.`
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
        `⏰ certo! Te dou um toque em **${minutos} minuto(s)**: "${mensagem}"`
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
    // RANK (LEADERBOARD DE XP)
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
    // RANKMOEDAS (LEADERBOARD DE MOEDAS)
    // =========================
    if (interaction.commandName === "rankmoedas") {
      const ranking = [...xpData.entries()]
        .filter(([, data]) => (data.coins || 0) > 0)
        .sort((a, b) => (b[1].coins || 0) - (a[1].coins || 0))
        .slice(0, 10);

      if (ranking.length === 0) {
        await interaction.reply("Ninguém tem moeda nenhuma ainda. Vai trabalhar, cria!");
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

        return `${posicao} **${nome}** — ${formatarMoedas(data.coins)}`;
      });

      const embed = new EmbedBuilder()
        .setTitle("💰 Ranking de moedas da Baguncinha")
        .setDescription(linhas.join("\n"))
        .setColor(0xf1c40f)
        .setThumbnail(usuarios[0]?.displayAvatarURL({ size: 256 }) || null)
        .setFooter({ text: `Top ${ranking.length} mais ricos do servidor` });

      await interaction.reply({ embeds: [embed] });
      console.log("✅ /rankmoedas respondido");
      return;
    }

    // =========================
    // EMBED (STAFF)
    // =========================
    if (interaction.commandName === "embed") {
      const titulo = interaction.options.getString("titulo");
      const descricao = interaction.options.getString("descricao").replace(/\\n/g, "\n");

      const draft = {
        titulo,
        descricao,
        cor: 0x5865f2,
        imagemUrl: null,
        footer: null,
        linkTitulo: null,
        canalId: null,
        autorNome: interaction.user.username
      };

      embedDrafts.set(interaction.user.id, draft);

      await interaction.reply({
        embeds: [montarPreviewEmbed(draft)],
        components: montarComponentesEmbedBuilder(),
        ephemeral: true
      });

      console.log("✅ /embed (construtor) aberto");
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

      await verificarMetaMoedas(interaction.channel, interaction.user.id, data);
      salvarDados();

      await interaction.reply(`🎁 Você resgatou seu presente diario e ganhou ${formatarMoedas(ganho)}!`);
      console.log("✅ /daily respondido");
      return;
    }

    // =========================
    // TRABALHAR
    // =========================
    if (interaction.commandName === "trabalhar") {
      const data = getUserData(interaction.user.id);
      const now = Date.now();

      const prisaoRestante = getPrisaoRestante(data);
      if (prisaoRestante > 0) {
        const minutosPreso = Math.ceil(prisaoRestante / (60 * 1000));
        await interaction.reply({
          content: `🚔 Você tá preso por causa daquele roubo malsucedido! Sai em ~${minutosPreso} min.`,
          ephemeral: true
        });
        return;
      }

      const trabalharCooldown = getTrabalharCooldown(data);
      if (now - data.lastTrabalhar < trabalharCooldown) {
        const restante = trabalharCooldown - (now - data.lastTrabalhar);
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
        "trabalhou de flanelinha",
        "trabalhou de ambulante",
        "trabalhou de entregador da shopee",
        "trabalhou de faxineiro(a)",
        "trabalhou de jardineiro",
        "trabalhou de ajudante de pedreiro"
      ];
      const trampo = TRAMPOS[Math.floor(Math.random() * TRAMPOS.length)];
      const ganho = Math.floor(Math.random() * 81) + 50; // 50 a 130

      data.coins += ganho;
      data.lastTrabalhar = now;

      await verificarMetaMoedas(interaction.channel, interaction.user.id, data);
      salvarDados();

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

      const prisaoRestante = getPrisaoRestante(data);
      if (prisaoRestante > 0) {
        const minutosPreso = Math.ceil(prisaoRestante / (60 * 1000));
        await interaction.reply({
          content: `🚔 Você tá preso por causa daquele roubo malsucedido! Sai em ~${minutosPreso} min.`,
          ephemeral: true
        });
        return;
      }

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
        await interaction.reply("🎣 Você ficou horas na beira do rio e não fisgou nada. Mais Sorte no próximo mn.");
        console.log("✅ /pescar respondido (nada)");
        return;
      }

      const ganho = Math.floor(Math.random() * 91) + 20; // 20 a 110
      data.coins += ganho;

      await verificarMetaMoedas(interaction.channel, interaction.user.id, data);
      salvarDados();

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
        await interaction.reply({ content: "❌ Não dá pra roubar de si mesmo, mn.", ephemeral: true });
        return;
      }
      if (alvo.bot) {
        await interaction.reply({ content: "❌ ta achando que ta facil assim ė?.", ephemeral: true });
        return;
      }

      const ladrao = getUserData(interaction.user.id);
      const vitima = getUserData(alvo.id);
      const now = Date.now();

      const prisaoRestante = getPrisaoRestante(ladrao);
      if (prisaoRestante > 0) {
        const minutosPreso = Math.ceil(prisaoRestante / (60 * 1000));
        await interaction.reply({
          content: `🚔 Você tá preso! Sai em ~${minutosPreso} min antes de tentar outra roubada.`,
          ephemeral: true
        });
        return;
      }

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

        await verificarMetaMoedas(interaction.channel, interaction.user.id, ladrao);
        salvarDados();

        await interaction.reply(
          `🕵️ Deu certo! Você roubou ${formatarMoedas(roubado)} de ${alvo.username}.`
        );
      } else {
        const multa = Math.floor(Math.random() * (300 - 80 + 1)) + 80; // perde 80 a 300
        ladrao.coins -= multa; // pode ficar negativo se não tiver o suficiente
        ladrao.presoAte = now + ROUBAR_PRISAO_MS;

        salvarDados();

        await interaction.reply(
          `🚨 Foi pego tentando roubar ${alvo.username} e pagou uma multa de ${formatarMoedas(multa)}. Ficou **preso por 15 minutos**! 🚔`
        );
      }

      console.log("✅ /roubar respondido");
      return;
    }

    // =========================
    // DOAR
    // =========================
    if (interaction.commandName === "doar") {
      const alvo = interaction.options.getUser("usuario");
      const quantidade = interaction.options.getInteger("quantidade");

      if (alvo.id === interaction.user.id) {
        await interaction.reply({ content: "❌ Não dá pra doar pra si mesmo mn (???).", ephemeral: true });
        return;
      }
      if (alvo.bot) {
        await interaction.reply({ content: "❌ ta me chamando de duro?.", ephemeral: true });
        return;
      }

      const doador = getUserData(interaction.user.id);

      if (doador.coins < quantidade) {
        await interaction.reply({
          content: `❌ Você não tem ${formatarMoedas(quantidade)} pra doar. Sua carteira: ${formatarMoedas(doador.coins)}.`,
          ephemeral: true
        });
        return;
      }

      const recebedor = getUserData(alvo.id);

      doador.coins -= quantidade;
      recebedor.coins += quantidade;

      await verificarMetaMoedas(interaction.channel, alvo.id, recebedor);
      salvarDados();

      await interaction.reply(
        `🤝 Você doou ${formatarMoedas(quantidade)} pra **${alvo.username}**. Bonito gesto.`
      );
      console.log("✅ /doar respondido");
      return;
    }

    // =========================
    // LOJA (embed + botões)
    // =========================
    if (interaction.commandName === "loja") {
      await interaction.reply({
        embeds: [montarEmbedLojaPrincipal()],
        components: montarComponentesLojaPrincipal()
      });
      console.log("✅ /loja respondido");
      return;
    }

    // =========================
    // COMPRAR (atalho por comando)
    // =========================
    if (interaction.commandName === "comprar") {
      const itemId = interaction.options.getString("item");
      await comprarItem(interaction, itemId);
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
        await verificarMetaMoedas(interaction.channel, interaction.user.id, data);
        salvarDados();

        await interaction.reply(
          `🪙 Deu **${resultado}**! Você dobrou a aposta e ganhou ${formatarMoedas(quantidade)}.`
        );
      } else {
        data.coins -= quantidade;
        salvarDados();

        await interaction.reply(
          `🪙 Deu **${resultado}**... você perdeu ${formatarMoedas(quantidade)}. Próxima.`
        );
      }

      console.log("✅ /apostar respondido");
      return;
    }

    // =========================
    // ROLETA
    // =========================
    if (interaction.commandName === "roleta") {
      const quantidade = interaction.options.getInteger("quantidade");
      const data = getUserData(interaction.user.id);
      const now = Date.now();

      if (now - data.lastRoleta < ROLETA_COOLDOWN_MS) {
        const restante = ROLETA_COOLDOWN_MS - (now - data.lastRoleta);
        const segundos = Math.ceil(restante / 1000);
        await interaction.reply({
          content: `⏳ A roleta ainda tá girando. Espera ~${segundos}s.`,
          ephemeral: true
        });
        return;
      }

      if (data.coins < quantidade) {
        await interaction.reply({
          content: `❌ Você não tem ${formatarMoedas(quantidade)}. Sua carteira: ${formatarMoedas(data.coins)}.`,
          ephemeral: true
        });
        return;
      }

      data.lastRoleta = now;
      data.coins -= quantidade;

      const resultado = sortearRoleta();
      const premio = Math.floor(quantidade * resultado.multiplicador);
      data.coins += premio;

      await verificarMetaMoedas(interaction.channel, interaction.user.id, data);
      salvarDados();

      const embed = new EmbedBuilder()
        .setTitle("🎰 ROLETA BAGUNCINHA")
        .setDescription(
          `Você apostou ${formatarMoedas(quantidade)}.\n\n` +
          `${resultado.label}\n\n` +
          `Você ganhou: ${formatarMoedas(premio)}\n` +
          `Saldo atual: ${formatarMoedas(data.coins)}`
        )
        .setColor(resultado.multiplicador >= 5 ? 0xf1c40f : resultado.multiplicador === 0 ? 0xe74c3c : 0x2ecc71);

      await interaction.reply({ embeds: [embed] });
      console.log("✅ /roleta respondido");
      return;
    }

    // =========================
    // PPT (PEDRA, PAPEL OU TESOURA)
    // =========================
    if (interaction.commandName === "ppt") {
      const alvo = interaction.options.getUser("usuario");
      const quantidade = interaction.options.getInteger("quantidade");

      if (alvo.id === interaction.user.id) {
        await interaction.reply({ content: "❌ Não dá pra desafiar você mesmo.", ephemeral: true });
        return;
      }
      if (alvo.bot) {
        await interaction.reply({ content: "❌ Bot não joga PPT.", ephemeral: true });
        return;
      }

      const desafianteData = getUserData(interaction.user.id);
      if (desafianteData.coins < quantidade) {
        await interaction.reply({
          content: `❌ Você não tem ${formatarMoedas(quantidade)}. Sua carteira: ${formatarMoedas(desafianteData.coins)}.`,
          ephemeral: true
        });
        return;
      }

      const matchId = interaction.id;
      pptMatches.set(matchId, {
        desafianteId: interaction.user.id,
        desafiadoId: alvo.id,
        aposta: quantidade,
        status: "aguardando",
        escolhas: {}
      });

      const linhaBotoes = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`ppt:aceitar:${matchId}`).setLabel("✅ Aceitar").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`ppt:recusar:${matchId}`).setLabel("❌ Recusar").setStyle(ButtonStyle.Danger)
      );

      await interaction.reply({
        content: `🪨📄✂️ ${interaction.user} desafiou ${alvo} para Pedra, Papel ou Tesoura apostando ${formatarMoedas(quantidade)}!\n${alvo}, aceita?`,
        components: [linhaBotoes]
      });

      console.log("✅ /ppt respondido");
      return;
    }

    // =========================
    // CONQUISTAS
    // =========================
    if (interaction.commandName === "conquistas") {
      const data = getUserData(interaction.user.id);
      const member = await interaction.guild.members.fetch(interaction.user.id);

      const desbloqueadasAgora = await verificarConquistas(member, data);

      await verificarMetaMoedas(interaction.channel, interaction.user.id, data);
      salvarDados();

      const linhas = Object.entries(CONQUISTAS).map(([id, conquista]) => {
        const status = data.conquistas.includes(id) ? "✅" : "🔒";
        return `${status} **${conquista.nome}** — ${conquista.descricao}`;
      });

      const embed = new EmbedBuilder()
        .setTitle(`🏆 Conquistas de ${interaction.user.username}`)
        .setDescription(linhas.join("\n"))
        .setColor(0xf1c40f);

      if (desbloqueadasAgora.length > 0) {
        embed.addFields({
          name: "🎉 Novas conquistas desbloqueadas!",
          value: desbloqueadasAgora
            .map(c => `${c.badge} ${c.nome} — +${formatarMoedas(c.moedas)}`)
            .join("\n")
        });
      }

      await interaction.reply({ embeds: [embed] });
      console.log("✅ /conquistas respondido");
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
    // EDITAR MOEDAS (ADMIN)
    // =========================
    if (interaction.commandName === "editarmoedas") {
      const alvo = interaction.options.getUser("usuario");
      const acao = interaction.options.getString("acao");
      const quantidade = interaction.options.getInteger("quantidade");

      const data = getUserData(alvo.id);

      if (acao === "adicionar") {
        data.coins += quantidade;
      } else if (acao === "remover") {
        data.coins = Math.max(0, data.coins - quantidade);
      } else if (acao === "definir") {
        data.coins = quantidade;
      }

      await verificarMetaMoedas(interaction.channel, alvo.id, data);
      salvarDados();

      await interaction.reply({
        content: `✅ Feito. Carteira de **${alvo.username}** agora tá em ${formatarMoedas(data.coins)}.`,
        ephemeral: true
      });
      console.log("✅ /editarmoedas respondido");
      return;
    }

    // =========================
    // BLOQUEAR CANAIS (ADMIN)
    // =========================
    if (interaction.commandName === "bloquearcanais") {
      if (NAO_VERIFICADO_ROLE_ID.startsWith("COLOQUE_")) {
        await interaction.reply({
          content: "❌ Configura o NAO_VERIFICADO_ROLE_ID no código antes de usar isso.",
          ephemeral: true
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      const guild = interaction.guild;
      const canalVerificacao = guild.channels.cache.find(
        c => c.name === "verificacao" && c.type === ChannelType.GuildText
      );

      let sucesso = 0;
      let falhas = 0;

      for (const canal of guild.channels.cache.values()) {
        if (canalVerificacao && canal.id === canalVerificacao.id) continue;
        if (!canal.permissionOverwrites) continue;

        try {
          await canal.permissionOverwrites.edit(NAO_VERIFICADO_ROLE_ID, { ViewChannel: false });
          sucesso++;
        } catch (error) {
          falhas++;
        }
      }

      if (canalVerificacao) {
        await canalVerificacao.permissionOverwrites
          .edit(NAO_VERIFICADO_ROLE_ID, { ViewChannel: true })
          .catch(() => {});
      }

      await interaction.editReply(
        `✅ Bloqueado em ${sucesso} canal(is).` +
        (falhas > 0 ? ` ⚠️ Falhou em ${falhas} (confere se meu cargo tá acima e se eu tenho "Gerenciar Cargos/Canais" lá).` : "")
      );
      console.log("✅ /bloquearcanais respondido");
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
// CARGOS POR INTERESSE (ONBOARDING NA ENTRADA)
// =========================
// Cole aqui os IDs dos cargos que cada interesse libera.
const INTEREST_ROLES = {
  valorant: "1476004304690348117",
  minecraft: "1553649152779485272",
  cs: "1553649152779485272",
  roblox: "1553649152779485272",
  geral: "1373017679379828908"
};

const NOMES_INTERESSES = {
  valorant: "🎯 Valorant",
  minecraft: "⛏️ Minecraft",
  cs: "🔫 CS",
  roblox: "🧱 Roblox",
  geral: "💬 Geral"
};

// =========================
// SERVIDOR HTTP — RENDER (só pra manter o serviço vivo)
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

    carregarDados();
    carregarMetas();

    await registerCommands();

    console.log("🔌 Conectando ao Discord...");
    await client.login(TOKEN);
  } catch (error) {
    console.error("❌ ERRO AO INICIAR O BOT:");
    console.error(error);
  }
}

// Salva automaticamente a cada 2 minutos
setInterval(salvarDados, 2 * 60 * 1000);

// Salva quando o processo for encerrado (deploy novo, reinício manual, etc.)
function encerrarComSalvamento() {
  console.log("💾 Salvando banco de dados antes de encerrar...");
  salvarDados();
  process.exit(0);
}
process.on("SIGINT", encerrarComSalvamento);
process.on("SIGTERM", encerrarComSalvamento);

start();
