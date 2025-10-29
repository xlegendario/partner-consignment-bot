// lib/discord.js
import fetch from "node-fetch";
import { Client, GatewayIntentBits, Events } from "discord.js";

const {
  DISCORD_BOT_TOKEN,
  DISCORD_GUILD_ID,
  DISCORD_CHANNEL_ID,
  ALLOW_CHANNEL_CREATE
} = process.env;

const API = "https://discord.com/api/v10";

// ---------- gateway client ----------
let client;

export async function initDiscord() {
  if (client) return client;
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,   // ✅ only this; no GuildMessages/MessageContent
    ],
  });
  await client.login(DISCORD_BOT_TOKEN);
  console.log("✅ Discord gateway logged in as", client.user?.tag);
  return client;
}

// Simple interaction dispatcher (button clicks)
let _buttonHandler = null;
export async function onButtonInteraction(handler) {
  await initDiscord();
  _buttonHandler = handler;

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (!interaction.isButton()) return;

      // custom_id = action|orderRecId|sellerId|inventoryRecordId|offerPrice
      const [action, orderRecId, sellerId, inventoryRecordId, offerPriceStr] =
        String(interaction.customId).split("|");
      const offerPrice = Number(offerPriceStr);

      await handler({
        action,
        orderRecId,
        sellerId,
        inventoryRecordId,
        offerPrice,
        channelId: interaction.channelId,
        messageId: interaction.message?.id,
      });

      // ack silently
      if (!interaction.replied && !interaction.deferred) {
        await interaction.deferUpdate();
      }
    } catch (err) {
      console.error("onButtonInteraction error:", err);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "Something went wrong.", ephemeral: true });
      }
    }
  });
}

/* -----------------------------------------------------------
   Channel helpers
----------------------------------------------------------- */
async function listGuildChannels() {
  if (!DISCORD_GUILD_ID) {
    if (!DISCORD_CHANNEL_ID) throw new Error("Set DISCORD_GUILD_ID or DISCORD_CHANNEL_ID.");
    return [{ id: DISCORD_CHANNEL_ID, type: 0, name: "fallback" }];
  }
  const res = await fetch(`${API}/guilds/${DISCORD_GUILD_ID}/channels`, {
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
  });
  if (!res.ok) throw new Error(`[Discord] list channels → ${res.status} ${await res.text()}`);
  return res.json();
}

async function createChannelInGuild({ name, type, parent_id }) {
  const body = { name, type };
  if (parent_id) body.parent_id = parent_id;
  const res = await fetch(`${API}/guilds/${DISCORD_GUILD_ID}/channels`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`[Discord] create channel "${name}" → ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Find (or create) the correct channel for a seller.
 * - Category name must equal seller name/id (case-insensitive).
 * - Channel “confirmation-requests” for matches, “offer-requests” for offers.
 */
async function getChannelIdForSeller(sellerNameOrId, kind) {
  const targetChannelName = kind === "confirm" ? "confirmation-requests" : "offer-requests";

  if (!DISCORD_GUILD_ID) {
    if (!DISCORD_CHANNEL_ID) throw new Error("Set DISCORD_CHANNEL_ID for fallback.");
    return { channelId: DISCORD_CHANNEL_ID, created: false };
  }

  const channels = await listGuildChannels();
  const wanted = (sellerNameOrId || "").trim();
  const wantedLc = wanted.toLowerCase();

  // category = type 4
  const category = channels.find(
    c => c.type === 4 && typeof c.name === "string" && c.name.trim().toLowerCase() === wantedLc
  );
  let categoryId = category?.id;

  if (!categoryId) {
    if (String(ALLOW_CHANNEL_CREATE).toLowerCase() === "true") {
      const cat = await createChannelInGuild({ name: wanted, type: 4 });
      categoryId = cat.id;
    } else {
      throw new Error(`Category not found for seller "${wanted}" and creation disabled`);
    }
  }

  // text channel under category (type 0)
  const channel = channels.find(
    c => c.type === 0 && c.parent_id === categoryId && c.name === targetChannelName
  );
  let channelId = channel?.id;

  if (!channelId) {
    if (String(ALLOW_CHANNEL_CREATE).toLowerCase() === "true") {
      const ch = await createChannelInGuild({ name: targetChannelName, type: 0, parent_id: categoryId });
      channelId = ch.id;
    } else {
      throw new Error(`Channel "${targetChannelName}" missing under category "${wanted}" and creation disabled`);
    }
  }

  return { channelId, created: !channel };
}

/* -----------------------------------------------------------
   Price helpers + labels
----------------------------------------------------------- */
// AFTER — confirm whenever seller ask is at or below our max
function shouldConfirm(suggested, adjustedMax) {
  return (typeof suggested === "number") &&
         (typeof adjustedMax === "number") &&
         suggested <= adjustedMax;
}

function vatSuffix({ vatType, sellerCountry, clientCountry }) {
  const vt = String(vatType || "").toUpperCase();
  const isNL = (s) => String(s || "").toLowerCase().includes("nether");
  const bothDutch = isNL(sellerCountry) && isNL(clientCountry);

  if (vt.includes("MARGIN")) return "(Margin)";
  if (vt.includes("VAT21")) return "(VAT 21%)";
  if (vt.includes("VAT0")) return bothDutch ? "(VAT 21%)" : "(VAT 0%)";
  return "";
}

/* -----------------------------------------------------------
   Public API: send + edit messages
----------------------------------------------------------- */
export async function sendOfferMessageGateway({
  orderRecId,
  orderHumanId,
  sellerId,
  sellerName,
  inventoryRecordId,
  productName,
  sku,
  size,
  suggested,
  adjustedTarget,
  adjustedMax,
  vatType,
  sellerCountry,
  clientCountry,
}) {
  const confirmCase = shouldConfirm(suggested, adjustedMax);
  const offerPrice  = confirmCase ? suggested : (typeof adjustedMax === "number" ? adjustedMax : null);

  const yourPriceLabel = vatSuffix({ vatType, sellerCountry, clientCountry });
  const ourPriceLabel  = vatSuffix({ vatType, sellerCountry, clientCountry });

  const title = inBetween
    ? `📋 Match found for ${sku} / ${size}`
    : `📑 Offer sent for ${sku} / ${size}`;

  const header = inBetween
    ? "🚀 Your Item Matched One Of Our Orders"
    : "🚨 We Got An Offer For Your Item";

  const lines = [
    header,
    "",
    "If you still have this pair, click **Confirm** below. FCFS — other sellers might also have this listed.",
    "",
    "**Product Name**",
    productName || "—",
    "",
    "**SKU**\n" + (sku ?? "—"),
    "**Size**\n" + (size ?? "—"),
    "**Your Price**\n" + (suggested != null ? `€${Number(suggested).toFixed(2)} ${yourPriceLabel}` : "—"),
  ];

  if (!inBetween) {
    lines.push("", "**Our Offer**", offerPrice != null ? `€${Number(offerPrice).toFixed(2)} ${ourPriceLabel}` : "—");
  }

  lines.push("", "**Order**", orderHumanId || orderRecId);

  const description = lines.join("\n");

  const kind = inBetween ? "confirm" : "offer";
  const { channelId } = await getChannelIdForSeller(sellerName || sellerId, kind);

  const components = [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 3,
          label: inBetween
            ? "Confirm (I have this pair)"
            : `Accept Offer €${offerPrice != null ? Number(offerPrice).toFixed(2) : "—"}`,
          custom_id: `confirm|${orderRecId}|${sellerId}|${inventoryRecordId}|${offerPrice ?? 0}`
        },
        {
          type: 2,
          style: 4,
          label: "Deny (Not available)",
          custom_id: `deny|${orderRecId}|${sellerId}|${inventoryRecordId}|${offerPrice ?? 0}`
        }
      ]
    }
  ];

  const embed = {
    title,
    description,
    color: inBetween ? 0x2ecc71 : 0xf1c40f,
    footer: { text: `SellerID: ${sellerId}` },
    timestamp: new Date().toISOString()
  };

  const res = await fetch(`${API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ embeds: [embed], components })
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`[Discord] send message → ${res.status} ${t}`);
  }

  const msg = await res.json();
  return { channelId, messageId: msg.id, offerPrice };
}

export async function disableMessageButtonsGateway(channelId, messageId, note) {
  const res = await fetch(`${API}/channels/${channelId}/messages/${messageId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 2, label: "Confirmed", custom_id: "confirmed", disabled: true },
            { type: 2, style: 2, label: "Denied", custom_id: "denied", disabled: true }
          ]
        }
      ],
      content: note ? `${note}` : undefined
    })
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`[Discord] edit message → ${res.status} ${t}`);
  }
  return res.json();
}
