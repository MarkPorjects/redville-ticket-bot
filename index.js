require("dotenv").config();
const http = require("http");
const {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionsBitField,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const {
  BOT_TOKEN,
  GUILD_ID,
  REPORT_CHANNEL_ID,
  TICKET_CATEGORY_ID,
  STAFF_ROLE_ID,
  CHANNEL_NAME_FORMAT = "reporter-subject",
} = process.env;

if (!BOT_TOKEN || !GUILD_ID || !REPORT_CHANNEL_ID || !TICKET_CATEGORY_ID || !STAFF_ROLE_ID) {
  console.error("[TicketBot] Missing required values in .env! Copy .env.example to .env and fill all fields.");
  process.exit(1);
}

const staffRoleIds = STAFF_ROLE_ID.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  ],
});

function sanitizeChannelPart(str, maxLen = 28) {
  return String(str || "")
    .toLowerCase()
    .replace(/[`*_~@]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen) || "report";
}

function getField(embed, name) {
  const f = embed.fields?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return f ? f.value : "";
}

async function findMemberByInput(guild, rawInput) {
  const clean = String(rawInput || "").replace(/[`@\s]/g, "").trim();
  if (!clean) return null;

  // 1. Numeric Discord User ID
  if (/^\d{17,20}$/.test(clean)) {
    try {
      return await guild.members.fetch(clean);
    } catch (_) {}
  }

  // 2. Query Discord members by username / display name
  try {
    const results = await guild.members.search({ query: clean, limit: 10 });
    const lower = clean.toLowerCase();
    const exact =
      results.find((m) => m.user.username.toLowerCase() === lower) ||
      results.find((m) => (m.user.globalName || "").toLowerCase() === lower) ||
      results.find((m) => m.displayName.toLowerCase() === lower);
    if (exact) return exact;
  } catch (err) {
    console.warn("[TicketBot] Member search error:", err.message);
  }

  return null;
}

client.once("clientReady", async () => {
  console.log(`[TicketBot] Logged in as ${client.user.tag} — watching report channel ${REPORT_CHANNEL_ID}`);
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const repCh = await guild.channels.fetch(REPORT_CHANNEL_ID);
    const catCh = await guild.channels.fetch(TICKET_CATEGORY_ID);
    console.log(`[TicketBot] Guild: ${guild.name} | ReportCh: #${repCh?.name} | Category: ${catCh?.name}`);
    const recent = await repCh.messages.fetch({ limit: 3 });
    console.log(`[TicketBot] Recent messages in #${repCh.name}: ${recent.size}`);
    for (const [, m] of recent) {
      console.log(`  - msg ${m.id} webhook=${m.webhookId} embeds=${m.embeds.length} title=${m.embeds[0]?.title || "(none)"} content=${JSON.stringify(m.content)}`);
    }
  } catch (err) {
    console.error("[TicketBot] Startup check error:", err.message);
  }
});

// Listen for Roblox /report webhook embeds
client.on("messageCreate", async (message) => {
  if (message.channelId !== REPORT_CHANNEL_ID) return;
  console.log(`[TicketBot] Saw msg in report channel: webhook=${message.webhookId} bot=${message.author?.bot} embeds=${message.embeds?.length} title=${message.embeds?.[0]?.title || "(none)"}`);
  if (!message.webhookId && !message.author.bot) return;
  if (!message.embeds || message.embeds.length === 0) {
    console.warn("[TicketBot] Message had 0 embeds! Enable MESSAGE CONTENT INTENT in Discord Developer Portal -> Bot, or ensure webhook mentions the bot.");
    return;
  }

  const embed = message.embeds[0];
  if (!embed.title || !embed.title.includes("REDVILLE CITY REPORT")) return;

  try {
    const guild = await client.guilds.fetch(GUILD_ID);

    const reportIdMatch = embed.title.match(/RPT-\d+/);
    const reportId = reportIdMatch ? reportIdMatch[0] : "RPT-0000";

    const discordRaw = getField(embed, "Discord Username").replace(/`/g, "").trim();
    const subjectRaw = getField(embed, "Subject").replace(/\*/g, "").trim();
    const categoryRaw = getField(embed, "Category").replace(/`/g, "").trim();
    const reporterField = getField(embed, "Reporter Profile");
    const reportedField = getField(embed, "Reported Player Profile");
    const detailsField = getField(embed, "Detailed Report");

    const member = await findMemberByInput(guild, discordRaw);

    const userSlug = sanitizeChannelPart(member ? member.user.username : discordRaw || "player", 24);
    const subjSlug = sanitizeChannelPart(subjectRaw || reportId, 28);

    const channelName =
      CHANNEL_NAME_FORMAT.toLowerCase() === "ticket-username"
        ? `ticket-${userSlug}`
        : `${userSlug}-${subjSlug}`;

    const permissionOverwrites = [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionsBitField.Flags.ViewChannel],
      },
      {
        id: client.user.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ManageChannels,
          PermissionsBitField.Flags.EmbedLinks,
          PermissionsBitField.Flags.AttachFiles,
        ],
      },
      ...staffRoleIds.map((roleId) => ({
        id: roleId,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.AttachFiles,
          PermissionsBitField.Flags.EmbedLinks,
          PermissionsBitField.Flags.ReadMessageHistory,
          PermissionsBitField.Flags.ManageMessages,
        ],
      })),
    ];

    if (member) {
      permissionOverwrites.push({
        id: member.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.AttachFiles,
          PermissionsBitField.Flags.EmbedLinks,
          PermissionsBitField.Flags.ReadMessageHistory,
        ],
      });
    }

    const ticketChannel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: TICKET_CATEGORY_ID,
      topic: `Report ${reportId} | Discord: ${discordRaw || "N/A"} | Subject: ${subjectRaw}`,
      permissionOverwrites,
    });

    const ticketEmbed = new EmbedBuilder()
      .setColor(0xe61e24)
      .setTitle(`EVIDENCE TICKET  |  ${reportId}`)
      .setDescription(
        member
          ? `Welcome ${member}! Please send any **screenshots or video evidence** for your report below. Staff will review shortly.`
          : `Could not auto-match Discord user \`${discordRaw}\` in this server. Staff can add them manually once they join.`
      )
      .addFields(
        { name: "Reporter Profile", value: reporterField || "N/A", inline: false },
        { name: "Reported Player Profile", value: reportedField || "N/A", inline: false },
        { name: "Category", value: `\`${categoryRaw || "Report Player"}\``, inline: true },
        { name: "Subject", value: `**${subjectRaw || "N/A"}**`, inline: true },
        { name: "Detailed Report", value: detailsField || "N/A", inline: false }
      )
      .setFooter({ text: "Sumbong mo kay Maki  •  Redville City Roleplay" })
      .setTimestamp();

    if (embed.thumbnail?.url) ticketEmbed.setThumbnail(embed.thumbnail.url);
    if (embed.image?.url) ticketEmbed.setImage(embed.image.url);

    const closeRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("close_ticket")
        .setLabel("Close Ticket")
        .setStyle(ButtonStyle.Danger)
    );

    const staffPings = staffRoleIds.map((id) => `<@&${id}>`).join(" ");
    const mentionLine = member ? `${member} ${staffPings}` : staffPings;

    await ticketChannel.send({
      content: mentionLine,
      embeds: [ticketEmbed],
      components: [closeRow],
    });

    // Reply in report log channel with direct link to the created ticket
    await message.reply({
      content: member
        ? `Ticket created for ${member}: <#${ticketChannel.id}> (\`${reportId}\`)`
        : `Ticket created: <#${ticketChannel.id}> (\`${reportId}\`) — Note: Discord user \`${discordRaw}\` was not found in the server.`,
    });

    console.log(`[TicketBot] Created #${ticketChannel.name} for ${reportId} (user: ${discordRaw})`);
  } catch (err) {
    console.error("[TicketBot] Failed to create ticket:", err);
  }
});

// Close Ticket Button Handler
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;
  if (interaction.customId !== "close_ticket") return;

  const isStaff =
    interaction.member.permissions.has(PermissionsBitField.Flags.ManageChannels) ||
    staffRoleIds.some((id) => interaction.member.roles.cache.has(id));

  if (!isStaff) {
    return interaction.reply({
      content: "Only Staff can close this ticket.",
      ephemeral: true,
    });
  }

  await interaction.reply({
    content: `Ticket closed by ${interaction.user}. Deleting channel in 5 seconds...`,
  });

  setTimeout(() => {
    interaction.channel.delete().catch(() => {});
  }, 5000);
});

// Keep-alive HTTP server for Render / cloud hosting health checks
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Redville Ticket Bot is online.");
  })
  .listen(PORT, () => {
    console.log(`[TicketBot] Health server listening on port ${PORT}`);
  });

client.login(BOT_TOKEN);
