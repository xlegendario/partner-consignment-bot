// lib/discord.js
import fetch from "node-fetch";
import { Client, GatewayIntentBits, Events } from "discord.js";

const {
  DISCORD_BOT_TOKEN,
  DISCORD_GUILD_ID,
  DISCORD_CHANNEL_ID,     // fallback single-channel mode (no categories)
  ALLOW_CHANNEL_CREATE,   // "true" to let the bot create categories/channels
} = process.env;

const API = "https://discord.com/api/v10";

/* -----------------------------------------------------------
   Gateway client (minimal intents to avoid blocked intents)
----------------------------------------------------------- */
let client;
export async function initDiscord() {
  if (client) return client;
  client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(DISCORD_BOT_TOKEN);
  console.log("✅ Discord logged in as", client.user?.tag);
  return client;
}

/* -----------------------------------------------------------
   Button interaction bridge (Confirm / Deny)
----------------------------------------------------------- */
export async function onButtonInteraction(handler) {
  await initDiscord();

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;

    // Immediately ACK so we never double-ack later
    await interaction.deferUpdate().catch(() => {});

    try {
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
    } catch (e) {
      // we already deferred, so just log
      console.error("onButtonInteraction error:", e);
    }
  });
}

/* -----------------------------------------------------------
   Channel helpers (per-seller categories)
----------------------------------------------------------- */
async function listGuildChannels() {
  if (!DISCORD_GUILD_ID) {
    if (!DISCORD_CHANNEL_ID) {
      throw new Error("Set DISCORD_CHANNEL_ID or DISCORD_GUILD_ID for routing.");
    }
    // fallback single channel mode
    return [{ id: DISCORD_CHANNEL_ID, type: 0, name: "fallback" }];
  }

  const r = await fetch(`${API}/guilds/${DISCORD_GUILD_ID}/channels`, {
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
  });
  if (!r.ok) throw new Error(`[Discord] list channels → ${r.status} ${await r.text()}`);
  return r.json();
}

async function createChannel({ name, type, parent_id }) {
  const body = { name, type };
  if (parent_id) body.parent_id = parent_id;

  const r = await fetch(`${API}/guilds/${DISCORD_GUILD_ID}/channels`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(
    `[Discord] create channel "${name}" → ${r.status} ${await r.text()}`
  );
  return r.json();
}

/**
 * Resolve the channel where we should post for a seller.
 * - Category name equals the seller name/id (case-insensitive).
 * - Under it, we post to "confirmation-requests" or "offer-requests".
 * - If DISCORD_GUILD_ID is not set, we fall back to DISCORD_CHANNEL_ID.
 */
async function getChannelIdForSeller(sellerNameOrId, kind) {
  const targetChannelName = kind === "confirm" ? "confirmation-requests" : "offer-requests";

  // Fallback: single channel mode
  if (!DISCORD_GUILD_ID) {
    if (!DISCORD_CHANNEL_ID) {
      throw new Error("Set DISCORD_CHANNEL_ID for fallback mode.");
    }
    return { channelId: DISCORD_CHANNEL_ID, created: false };
  }

  const channels = await listGuildChannels();
  const wanted = String(sellerNameOrId || "").trim();
  const wantedLc = wanted.toLowerCase();

  // Category = type 4
  const category = channels.find(
    c => c.type === 4 && typeof c.name === "string" && c.name.trim().toLowerCase() === wantedLc
  );
  let categoryId = category?.id;

  if (!categoryId) {
    if (String(ALLOW_CHANNEL_CREATE).toLowerCase() === "true") {
      const cat = await createChannel({ name: wanted || "unknown-seller", type: 4 });
      categoryId = cat.id;
      console.log(`[discord] created category "${wanted}" → ${categoryId}`);
    } else {
      throw new Error(`Category not found for seller "${wanted}" and creation disabled`);
    }
  }

  // Text channel under category (type 0)
  const channel = channels.find(
    c => c.type === 0 && c.parent_id === categoryId && c.name === targetChannelName
  );
  if (channel) return { channelId: channel.id, created: false };

  if (String(ALLOW_CHANNEL_CREATE).toLowerCase() === "true") {
    const ch = await createChannel({ name: targetChannelName, type: 0, parent_id: categoryId });
    console.log(`[discord] created #${targetChannelName} under "${wanted}" → ${ch.id}`);
    return { channelId: ch.id, created: true };
  }

  throw new Error(`Channel "${targetChannelName}" missing under "${wanted}" and creation disabled`);
}

/* -----------------------------------------------------------
   Pricing helpers + VAT labels
----------------------------------------------------------- */

/**
 * If `normalizedSuggested` is present, it’s the seller ask normalized
 * into the client-vat context (e.g., VAT0→VAT21 when both Dutch).
 * That’s the number we compare against max.
 */
function pickComparePrice({ normalizedSuggested, suggested }) {
  return (typeof normalizedSuggested === "number") ? normalizedSuggested : suggested;
}

/** Confirm whenever seller ask (normalized) ≤ adjustedMax */
function shouldConfirm(comparePrice, adjustedMax) {
  return (typeof comparePrice === "number") &&
         (typeof adjustedMax === "number") &&
         comparePrice <= adjustedMax;
}

/** Label shown after prices to indicate regime shown to seller */
function vatSuffix({ vatType, sellerCountry, clientCountry }) {
  const vt = String(vatType || "").toUpperCase();
  const isNL = (s) => String(s || "").toLowerCase().includes("nether");
  const bothDutch = isNL(sellerCountry) && isNL(clientCountry);

  if (vt.includes("MARGIN")) return "(Margin)";
  if (vt.includes("VAT21"))  return "(VAT 21%)";
  if (vt.includes("VAT0"))   return bothDutch ? "(VAT 21%)" : "(VAT 0%)";
  return "";
}

/* -----------------------------------------------------------
   Public API: send + disable messages
----------------------------------------------------------- */

/**
 * Sends an embed with Confirm / Deny.
 * Inputs expected (from server.js):
 *   - suggested               (seller ask as entered)
 *   - normalizedSuggested     (seller ask normalized to client VAT context, if available)
 *   - adjustedMax             (max we can pay in the same context as normalizedSuggested)
 *   - vatType, sellerCountry, clientCountry
 *   - quantity                (display only)
 */
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
  normalizedSuggested,
  adjustedMax,
  vatType,
  sellerCountry,
  clientCountry,
  quantity,
}) {
  const comparePrice = pickComparePrice({ normalizedSuggested, suggested });
  const confirmCase  = shouldConfirm(comparePrice, adjustedMax);
  const offerPrice   = confirmCase
    ? comparePrice
    : (typeof adjustedMax === "number" ? adjustedMax : null);

  const yourPriceTag = vatSuffix({ vatType, sellerCountry, clientCountry });
  const ourPriceTag  = vatSuffix({ vatType, sellerCountry, clientCountry });

  const title  = confirmCase
    ? `📋 Match found for ${sku} / ${size}`
    : `📑 Offer sent for ${sku} / ${size}`;

  const header = confirmCase
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
    "**SKU**",
    sku ?? "—",
    "**Size**",
    size ?? "—",
    "**Quantity**",
    (typeof quantity === "number" ? quantity : 1),
    "**Your Price**",
    (suggested != null ? `€${Number(suggested).toFixed(2)} ${yourPriceTag}` : "—"),
  ];

  if (!confirmCase) {
    lines.push(
      "",
      "**Our Offer**",
      offerPrice != null ? `€${Number(offerPrice).toFixed(2)} ${ourPriceTag}` : "—"
    );
  }

  lines.push("", "**Order**", orderHumanId || orderRecId);
  const description = lines.join("\n");

  // Resolve channel (confirm vs offer) in the seller's category
  const kind = confirmCase ? "confirm" : "offer";
  const { channelId } = await getChannelIdForSeller(sellerName || sellerId, kind);
  if (!channelId) {
    throw new Error(
      `[Discord] No channelId resolved for seller="${sellerName || sellerId}", kind=${kind}. ` +
      `Check DISCORD_GUILD_ID and ALLOW_CHANNEL_CREATE.`
    );
  }
  console.log(`[discord] posting to seller="${sellerName || sellerId}" kind=${kind} channelId=${channelId}`);

  // Buttons
  const components = [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 3,
          label: confirmCase
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
    color: confirmCase ? 0x2ecc71 : 0xf1c40f,
    footer: { text: `SellerID: ${sellerId}` },
    timestamp: new Date().toISOString(),
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
    throw new Error(`send message → ${res.status} ${t}`);
  }

  const msg = await res.json();
  return { channelId, messageId: msg.id, offerPrice };
}

export async function disableMessageButtonsGateway(channelId, messageId, note) {
  const r = await fetch(`${API}/channels/${channelId}/messages/${messageId}`, {
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
            { type: 2, style: 2, label: "Denied",    custom_id: "denied",    disabled: true }
          ]
        }
      ],
      content: note ? `${note}` : undefined
    })
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`edit message → ${r.status} ${t}`);
  }
  return r.json();
}
