// lib/discord.js
import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events
} from "discord.js";

const {
  DISCORD_BOT_TOKEN,
  DISCORD_GUILD_ID,
  DISCORD_CHANNEL_ID,   // fallback single channel (optional)
  ALLOW_CHANNEL_CREATE  // "true" to auto-create categories/channels
} = process.env;

let client;

/** Initialize the Discord Gateway client and log in */
export async function initDiscord() {
  if (client) return client;

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages
    ],
    partials: [Partials.Channel, Partials.Message]
  });

  client.once(Events.ClientReady, (c) => {
    console.log(`✅ Discord gateway logged in as ${c.user.tag}`);
  });

  await client.login(DISCORD_BOT_TOKEN);
  return client;
}

/** Fetch the guild we operate in */
export async function getGuild() {
  if (!DISCORD_GUILD_ID) {
    throw new Error("DISCORD_GUILD_ID env var is required for per-seller categories.");
  }
  return client.guilds.fetch(DISCORD_GUILD_ID);
}

/** List all channels in the guild (fresh from API) */
async function listGuildChannels(guild) {
  // Fetching via Discord.js returns a Collection; convert to array
  const col = await guild.channels.fetch();
  return Array.from(col.values()).filter(Boolean);
}

/** Create a channel (category or text) */
async function createChannelInGuild(guild, { name, type, parentId }) {
  const opts = { name, type };
  if (parentId) opts.parent = parentId;
  const ch = await guild.channels.create(opts);
  return ch;
}

/**
 * Find (or create) the correct channel for a seller.
 * - Category = sellerName (case-insensitive match)
 * - Channel = "confirmation-requests" or "offer-requests"
 */
async function getChannelIdForSeller(guild, sellerNameOrId, kind) {
  const targetChannelName = kind === "confirm" ? "confirmation-requests" : "offer-requests";

  // Fallback single-channel mode if no guild id (not recommended)
  if (!DISCORD_GUILD_ID) {
    if (!DISCORD_CHANNEL_ID) throw new Error("Set DISCORD_GUILD_ID or DISCORD_CHANNEL_ID.");
    return { channelId: DISCORD_CHANNEL_ID, created: false };
  }

  const wanted = (sellerNameOrId || "").trim();
  const wantedLc = wanted.toLowerCase();

  const channels = await listGuildChannels(guild);

  // Find category (type = 4) by case-insensitive name
  let category = channels.find(
    c => c?.type === ChannelType.GuildCategory &&
         typeof c?.name === "string" &&
         c.name.trim().toLowerCase() === wantedLc
  );

  if (!category) {
    if (String(ALLOW_CHANNEL_CREATE).toLowerCase() === "true") {
      category = await createChannelInGuild(guild, { name: wanted, type: ChannelType.GuildCategory });
      console.log(`📁 Created category "${wanted}"`);
    } else {
      throw new Error(`Category not found for seller "${wanted}" and creation disabled`);
    }
  }

  // Find child text channel under that category
  let target = channels.find(
    c => c?.type === ChannelType.GuildText &&
         c?.parentId === category.id &&
         c?.name === targetChannelName
  );

  if (!target) {
    if (String(ALLOW_CHANNEL_CREATE).toLowerCase() === "true") {
      target = await createChannelInGuild(guild, {
        name: targetChannelName,
        type: ChannelType.GuildText,
        parentId: category.id
      });
      console.log(`📝 Created #${targetChannelName} in "${category.name}"`);
    } else {
      throw new Error(`Channel "${targetChannelName}" missing in category "${category.name}" and creation disabled`);
    }
  }

  return { channelId: target.id, created: !target };
}

/** Build the embed + buttons for an offer/confirmation */
function buildOfferMessage({ orderRecId, orderHumanId, sellerId, sellerName, sku, size, suggested, target, max }) {
  const nums = [suggested, target, max];
  const inBetween =
    nums.every(n => typeof n === "number" && !Number.isNaN(n)) &&
    suggested >= target && suggested <= max;

  const offerPrice = inBetween ? suggested : max;

  const title = inBetween
    ? `Confirm availability at €${Number(suggested).toFixed(2)}`
    : `Offer: €${Number(max).toFixed(2)} (your ask: €${Number(suggested).toFixed(2)})`;

  const description = [
    `**Order**: ${orderHumanId || orderRecId}`,
    `**Seller**: ${sellerName || sellerId}`,
    `**SKU / Size**: ${sku} / ${size}`,
    `**Suggested**: ${suggested != null ? `€${Number(suggested).toFixed(2)}` : "n/a"}`,
    `**Target / Max**: €${target ?? "n/a"} / €${max ?? "n/a"}`
  ].join("\n");

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(inBetween ? 0x2ecc71 : 0xf1c40f)
    .setFooter({ text: `SellerID: ${sellerId}` })
    .setTimestamp(new Date());

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Success)
      .setLabel(inBetween ? "Confirm (I have this pair)" : `Accept Offer €${Number(offerPrice).toFixed(2)}`)
      .setCustomId(`confirm|${orderRecId}|${sellerId}|__INV__|${offerPrice}`), // inventory id will be filled in caller

    new ButtonBuilder()
      .setStyle(ButtonStyle.Danger)
      .setLabel("Deny (Not available)")
      .setCustomId(`deny|${orderRecId}|${sellerId}|__INV__|${offerPrice}`)
  );

  return { embed, row, kind: inBetween ? "confirm" : "offer", offerPrice };
}

/** Send the message for a seller and return { channelId, messageId, offerPrice } */
export async function sendOfferMessageGateway({
  orderRecId, orderHumanId,
  sellerId, sellerName,
  inventoryRecordId,
  sku, size, suggested, target, max
}) {
  const guild = await getGuild();

  const { embed, row, kind, offerPrice } = buildOfferMessage({
    orderRecId, orderHumanId, sellerId, sellerName, sku, size, suggested, target, max
  });

  // Fix customIds to include the real inventoryRecordId
  row.components[0].setCustomId(`confirm|${orderRecId}|${sellerId}|${inventoryRecordId}|${offerPrice}`);
  row.components[1].setCustomId(`deny|${orderRecId}|${sellerId}|${inventoryRecordId}|${offerPrice}`);

  const { channelId } = await getChannelIdForSeller(guild, sellerName || sellerId, kind);
  const channel = await client.channels.fetch(channelId);

  const sent = await channel.send({
    content: `🧾 Match: **${sku} / ${size}**`,
    embeds: [embed],
    components: [row]
  });

  console.log(`[SEND] ${sellerName || sellerId} → #${kind === "confirm" ? "confirmation-requests" : "offer-requests"} (${sent.id})`);
  return { channelId, messageId: sent.id, offerPrice };
}

/** Disable buttons on a message and optionally add a note */
export async function disableMessageButtonsGateway(channelId, messageId, note) {
  const channel = await client.channels.fetch(channelId);
  const msg = await channel.messages.fetch(messageId);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel("Confirmed").setCustomId("confirmed").setDisabled(true),
    new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel("Denied").setCustomId("denied").setDisabled(true)
  );

  await msg.edit({ components: [row], content: note ?? msg.content });
}

/** Register a handler for button clicks (confirm/deny) */
export function onButtonInteraction(handler) {
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;

    const [action, orderRecId, sellerId, inventoryRecordId, offerPriceStr] =
      String(interaction.customId || "").split("|");

    const ctx = {
      action,
      orderRecId,
      sellerId,
      inventoryRecordId,
      offerPrice: Number(offerPriceStr),
      channelId: interaction.channelId,
      messageId: interaction.message?.id
    };

    // Acknowledge immediately so UI shows “thinking…”
    try {
      await interaction.deferUpdate(); // edits same message later; no extra reply
    } catch {}

    try {
      await handler(ctx);
    } catch (e) {
      console.error("Button handler error:", e);
    }
  });
}
