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

let client = undefined;
let clientPromise = undefined;

/** Initialize the Discord Gateway client and log in (idempotent) */
export async function initDiscord() {
  if (client) return client;
  if (clientPromise) return clientPromise;

  clientPromise = (async () => {
    const c = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
      partials: [Partials.Channel, Partials.Message]
    });

    c.once(Events.ClientReady, (ready) => {
      console.log(`✅ Discord gateway logged in as ${ready.user.tag}`);
    });

    await c.login(DISCORD_BOT_TOKEN);
    client = c;
    return client;
  })();

  return clientPromise;
}

/** Fetch the guild we operate in */
export async function getGuild() {
  if (!DISCORD_GUILD_ID) {
    throw new Error("DISCORD_GUILD_ID env var is required for per-seller categories.");
  }
  const c = await initDiscord();
  return c.guilds.fetch(DISCORD_GUILD_ID);
}

/** List all channels in the guild (fresh from API) */
async function listGuildChannels(guild) {
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
  const targetChannelName = kind === "offer" ? "offer-requests" : "confirmation-requests";

  if (!DISCORD_GUILD_ID) {
    if (!DISCORD_CHANNEL_ID) throw new Error("Set DISCORD_GUILD_ID or DISCORD_CHANNEL_ID.");
    return { channelId: DISCORD_CHANNEL_ID, created: false };
  }

  const wanted = (sellerNameOrId || "").trim();
  const wantedLc = wanted.toLowerCase();

  const channels = await listGuildChannels(guild);

  // Case-insensitive category
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

  // Child text channel
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

/** € formatter */
function eur(n) {
  return typeof n === "number" && !Number.isNaN(n) ? `€${Number(n).toFixed(2)}` : "n/a";
}

/**
 * Build the embed + buttons for your 3 scenarios:
 * 1) suggested < target  → Confirm (rocket)
 * 2) target ≤ suggested ≤ max → Confirm (rocket)
 * 3) suggested > max → Offer max (rotating_light)
 */
function buildOfferMessage({
  orderRecId, orderHumanId, sellerId, sellerName,
  productName, sku, size, suggested, target, max
}) {
  const hasSuggested = typeof suggested === "number" && !Number.isNaN(suggested);
  const hasTarget    = typeof target === "number" && !Number.isNaN(target);
  const hasMax       = typeof max === "number"    && !Number.isNaN(max);

  const lowerThanTarget = hasSuggested && hasTarget ? suggested < target : false;
  const withinTargetMax = hasSuggested && hasTarget && hasMax ? (suggested >= target && suggested <= max) : false;
  const aboveMax        = hasSuggested && hasMax ? suggested > max : false;

  // Decide scenario
  let kind = "confirm";  // confirm | offer
  if (aboveMax) kind = "offer";

  // Offer price used in confirm/offer buttons:
  const offerPrice = kind === "offer" ? max : suggested;

  // Title & color
  const title = kind === "offer"
    ? "🚨 We Got An Offer For Your Item"
    : "🚀 Your Item Matched One Of Our Orders";

  const color = kind === "offer" ? 0xe67e22 : 0x2ecc71; // orange vs green

  // Description per your copy (short + FCFS note)
  const descConfirm = "If you still have this pair, click **Confirm** below. FCFS — other sellers might also have this listed.";
  const descOffer   = "If you can accept our offer, click **Confirm** below. FCFS — other sellers might also have this listed.";

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .addFields(
      { name: "Product Name", value: productName || "—", inline: false },
      { name: "SKU", value: sku || "—", inline: true },
      { name: "Size", value: String(size ?? "—"), inline: true },
      ...(kind === "offer"
        ? [
            { name: "Your Price", value: eur(suggested), inline: true },
            { name: "Our Offer", value: eur(max), inline: true },
          ]
        : [
            { name: "Price", value: eur(suggested), inline: true },
          ]
      ),
      { name: "Order", value: orderHumanId || orderRecId, inline: false }
    )
    .setDescription(kind === "offer" ? descOffer : descConfirm)
    .setFooter({ text: `SellerID: ${sellerId}` })
    .setTimestamp(new Date());

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Success)
      .setLabel(kind === "offer" ? `Accept Offer ${eur(offerPrice)}` : "Confirm (I have this pair)")
      .setCustomId(`confirm|${orderRecId}|${sellerId}|__INV__|${offerPrice}`),
    new ButtonBuilder()
      .setStyle(ButtonStyle.Danger)
      .setLabel("Deny (Not available)")
      .setCustomId(`deny|${orderRecId}|${sellerId}|__INV__|${offerPrice}`)
  );

  return { embed, row, kind, offerPrice };
}

/** Send the message for a seller and return { channelId, messageId, offerPrice } */
export async function sendOfferMessageGateway({
  orderRecId, orderHumanId,
  sellerId, sellerName,
  inventoryRecordId,
  productName,              // 👈 NEW
  sku, size, suggested, target, max
}) {
  const guild = await getGuild();

  const { embed, row, kind, offerPrice } = buildOfferMessage({
    orderRecId, orderHumanId, sellerId, sellerName, productName, sku, size, suggested, target, max
  });

  // Fill inventory id in customIds
  row.components[0].setCustomId(`confirm|${orderRecId}|${sellerId}|${inventoryRecordId}|${offerPrice}`);
  row.components[1].setCustomId(`deny|${orderRecId}|${sellerId}|${inventoryRecordId}|${offerPrice}`);

  const { channelId } = await getChannelIdForSeller(guild, sellerName || sellerId, kind);
  const c = await initDiscord();
  const channel = await c.channels.fetch(channelId);

  const sent = await channel.send({
    content: kind === "offer"
      ? `🧾 **Offer sent** for **${sku} / ${size}**`
      : `🧾 **Match found** for **${sku} / ${size}**`,
    embeds: [embed],
    components: [row]
  });

  console.log(`[SEND] ${sellerName || sellerId} → #${kind === "offer" ? "offer-requests" : "confirmation-requests"} (${sent.id})`);
  return { channelId, messageId: sent.id, offerPrice };
}

/** Disable buttons on a message and optionally add a note */
export async function disableMessageButtonsGateway(channelId, messageId, note) {
  const c = await initDiscord();
  const channel = await c.channels.fetch(channelId);
  const msg = await channel.messages.fetch(messageId);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel("Confirmed").setCustomId("confirmed").setDisabled(true),
    new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel("Denied").setCustomId("denied").setDisabled(true)
  );

  await msg.edit({ components: [row], content: note ?? msg.content });
}

/** Register a handler for button clicks (confirm/deny). Safe to call before init; it will await the client. */
export async function onButtonInteraction(handler) {
  const c = await initDiscord();
  c.on(Events.InteractionCreate, async (interaction) => {
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

    try { await interaction.deferUpdate(); } catch {}

    try {
      await handler(ctx);
    } catch (e) {
      console.error("Button handler error:", e);
    }
  });
}
