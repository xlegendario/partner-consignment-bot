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

/* =========================
   Gateway (minimal intents)
   ========================= */
let client;
export async function initDiscord() {
  if (client) return client;
  client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(DISCORD_BOT_TOKEN);
  console.log("✅ Discord logged in as", client.user?.tag);
  return client;
}

/* =========================
   Button interactions (ACK once)
   ========================= */
export async function onButtonInteraction(handler) {
  await initDiscord();
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;

    // ACK immediately (prevents “already acknowledged” errors)
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
      // Do NOT reply again; we already deferred.
      console.error("onButtonInteraction error:", e);
    }
  });
}

/* =========================
   Channel helpers
   ========================= */
async function listGuildChannels() {
  if (!DISCORD_GUILD_ID) {
    if (!DISCORD_CHANNEL_ID)
      throw new Error("Set DISCORD_CHANNEL_ID or DISCORD_GUILD_ID");
    return [{ id: DISCORD_CHANNEL_ID, type: 0, name: "fallback" }];
  }
  const r = await fetch(`${API}/guilds/${DISCORD_GUILD_ID}/channels`, {
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
  });
  if (!r.ok) throw new Error(`list channels → ${r.status} ${await r.text()}`);
  return r.json();
}

async function createChannel({ name, type, parent_id }) {
  const r = await fetch(`${API}/guilds/${DISCORD_GUILD_ID}/channels`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ name, type, parent_id })
  });
  if (!r.ok) throw new Error(`create channel → ${r.status} ${await r.text()}`);
  return r.json();
}

/** Resolve (and optionally create) the seller’s channel. */
async function getChannelIdForSeller(sellerNameOrId, kind) {
  const target = kind === "confirm" ? "confirmation-requests" : "offer-requests";

  if (!DISCORD_GUILD_ID) {
    if (!DISCORD_CHANNEL_ID) throw new Error("Set DISCORD_CHANNEL_ID for fallback.");
    return { channelId: DISCORD_CHANNEL_ID, created: false };
  }

  const chans = await listGuildChannels();
  const wanted = String(sellerNameOrId || "").trim();
  const wantedLc = wanted.toLowerCase();

  // category = type 4
  const cat = chans.find(
    c => c.type === 4 && typeof c.name === "string" && c.name.trim().toLowerCase() === wantedLc
  );
  let categoryId = cat?.id;

  if (!categoryId) {
    if (String(ALLOW_CHANNEL_CREATE).toLowerCase() === "true") {
      const createdCat = await createChannel({ name: wanted, type: 4 });
      categoryId = createdCat.id;
    } else {
      throw new Error(`Category not found for seller "${wanted}" and creation disabled`);
    }
  }

  // text channel under category (type 0)
  const existing = chans.find(
    c => c.type === 0 && c.parent_id === categoryId && c.name === target
  );
  if (existing) return { channelId: existing.id, created: false };

  if (String(ALLOW_CHANNEL_CREATE).toLowerCase() === "true") {
    const created = await createChannel({ name: target, type: 0, parent_id: categoryId });
    return { channelId: created.id, created: true };
  }

  throw new Error(`Channel "${target}" missing under seller "${wanted}" and creation disabled`);
}

/* =========================
   Price helpers + labels
   ========================= */
const isNL = s => String(s || "").toLowerCase().includes("nether");

function vatSuffix({ vatType, sellerCountry, clientCountry }) {
  const vt = String(vatType || "").toUpperCase();
  const bothDutch = isNL(sellerCountry) && isNL(clientCountry);
  if (vt.includes("MARGIN")) return "(Margin)";
  if (vt.includes("VAT21"))  return "(VAT 21%)";
  if (vt.includes("VAT0"))   return bothDutch ? "(VAT 21%)" : "(VAT 0%)";
  return "";
}

function shouldConfirm(suggested, adjustedMax) {
  return (typeof suggested === "number") &&
         (typeof adjustedMax === "number") &&
         suggested <= adjustedMax;
}

/* =========================
   Send + Disable
   ========================= */
export async function sendOfferMessageGateway({
  orderRecId,
  orderHumanId,
  sellerId,
  sellerName,
  inventoryRecordId,
  productName,
  sku,
  size,
  // prices from Airtable
  suggested,             // original seller ask (may be ex-VAT if VAT0)
  normalizedSuggested,   // seller ask normalized to gross when needed
  adjustedMax,           // your max (gross) used for decision
  // meta
  vatType,
  sellerCountry,
  clientCountry,
  clientVatRate,
  quantity
}) {
  const bothDutch = isNL(sellerCountry) && isNL(clientCountry);
  const rate = 1 + (Number(clientVatRate) || 0) / 100;

  // What to COMPARE with:
  // Use normalizedSuggested if provided; else compute for VAT0 NL↔NL.
  const effectiveSuggested =
    (typeof normalizedSuggested === "number")
      ? normalizedSuggested
      : (String(vatType || "").toUpperCase().includes("VAT0") && bothDutch && typeof suggested === "number")
          ? suggested * rate
          : suggested;

  const confirmCase = shouldConfirm(effectiveSuggested, adjustedMax);
  const offerPrice  = confirmCase
    ? effectiveSuggested
    : (typeof adjustedMax === "number" ? adjustedMax : null);

  // What to SHOW in “Your Price”:
  const displaySuggested =
    (String(vatType || "").toUpperCase().includes("VAT0") && bothDutch && typeof suggested === "number")
      ? suggested * rate
      : suggested;

  const yourTag = vatSuffix({ vatType, sellerCountry, clientCountry });
  const ourTag  = vatSuffix({ vatType, sellerCountry, clientCountry });

  const title  = confirmCase ? `📋 Match found for ${sku} / ${size}` : `📑 Offer sent for ${sku} / ${size}`;
  const header = confirmCase ? "🚀 Your Item Matched One Of Our Orders" : "🚨 We Got An Offer For Your Item`;

  const lines = [
    header,
    "",
    "If you still have this pair, click **Confirm** below. FCFS — other sellers might also have this listed.",
    "",
    "**Product Name**",
    productName || "—",
    "",
    "**SKU**\n"  + (sku  ?? "—"),
    "**Size**\n" + (size ?? "—"),
    "**Quantity**\n" + (quantity ?? 0),
    "**Your Price**\n" + (displaySuggested != null ? `€${Number(displaySuggested).toFixed(2)} ${yourTag}` : "—"),
  ];
  if (!confirmCase) {
    lines.push("", "**Our Offer**", offerPrice != null ? `€${Number(offerPrice).toFixed(2)} ${ourTag}` : "—");
  }
  lines.push("", "**Order**", orderHumanId || orderRecId);

  const description = lines.join("\n");

  // Resolve channel by seller category + (offer|confirm) subchannel
  const kind = confirmCase ? "confirm" : "offer";
  const { channelId } = await getChannelIdForSeller(sellerName || sellerId, kind);
  if (!channelId) {
    throw new Error(
      `[Discord] No channelId resolved for seller="${sellerName || sellerId}", kind=${kind}. ` +
      `Check DISCORD_GUILD_ID and ALLOW_CHANNEL_CREATE.`
    );
  }
  console.log(`[discord] posting to seller="${sellerName || sellerId}" kind=${kind} channelId=${channelId}`);

  const components = [{
    type: 1,
    components: [
      {
        type: 2, style: 3,
        label: confirmCase
          ? "Confirm (I have this pair)"
          : `Accept Offer €${offerPrice != null ? Number(offerPrice).toFixed(2) : "—"}`,
        custom_id: `confirm|${orderRecId}|${sellerId}|${inventoryRecordId}|${offerPrice ?? 0}`
      },
      {
        type: 2, style: 4,
        label: "Deny (Not available)",
        custom_id: `deny|${orderRecId}|${sellerId}|${inventoryRecordId}|${offerPrice ?? 0}`
      }
    ]
  }];

  const embed = {
    title,
    description,
    color: confirmCase ? 0x2ecc71 : 0xf1c40f,
    footer: { text: `SellerID: ${sellerId}` },
    timestamp: new Date().toISOString()
  };

  const res = await fetch(`${API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed], components })
  });
  if (!res.ok) throw new Error(`send message → ${res.status} ${await res.text()}`);
  const msg = await res.json();
  return { channelId, messageId: msg.id, offerPrice };
}

/** Disable buttons on a message (used when matched or denied) */
export async function disableMessageButtonsGateway(channelId, messageId, note) {
  const r = await fetch(`${API}/channels/${channelId}/messages/${messageId}`, {
    method: "PATCH",
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      components: [{
        type: 1,
        components: [
          { type: 2, style: 2, label: "Confirmed", custom_id: "confirmed", disabled: true },
          { type: 2, style: 2, label: "Denied", custom_id: "denied", disabled: true }
        ]
      }],
      content: note ? `${note}` : undefined
    })
  });
  if (!r.ok) throw new Error(`edit message → ${r.status} ${await r.text()}`);
  return r.json();
}
