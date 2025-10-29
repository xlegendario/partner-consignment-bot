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

/* ----------------------------- Utils ----------------------------- */
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const isNL = (s) => String(s || "").toLowerCase().includes("nether");

/** Label to append to amounts */
function vatSuffix({ vatType, sellerCountry }) {
  const vt = String(vatType || "").toUpperCase();
  if (vt.includes("MARGIN")) return "(Margin)";
  if (vt.includes("VAT21"))  return "(VAT 21%)";
  if (vt.includes("VAT0"))   return isNL(sellerCountry) ? "(VAT 21%)" : "(VAT 0%)";
  return "";
}

/** For the *displayed* “Your Price” line */
function displayYourPrice({ suggested, vatType, sellerCountry, sellerVatRatePct }) {
  const vt = String(vatType || "").toUpperCase();
  if (vt.includes("VAT0") && isNL(sellerCountry)) {
    const pct = (typeof sellerVatRatePct === "number" && sellerVatRatePct > 0)
      ? sellerVatRatePct : 21; // fallback to 21%
    return round2(Number(suggested) * (1 + pct / 100));
  }
  return round2(suggested);
}

/* -------------------------- Gateway client ----------------------- */
let client;
export async function initDiscord() {
  if (client) return client;
  client = new Client({
    intents: [GatewayIntentBits.Guilds], // minimal, avoids "disallowed intents"
  });
  await client.login(DISCORD_BOT_TOKEN);
  console.log("✅ Discord logged in as", client.user?.tag);
  return client;
}

/** Button dispatcher (Confirm/Deny) */
export async function onButtonInteraction(handler) {
  await initDiscord();
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;
    // Ack immediately so we never double-ack later
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
    } catch (err) {
      console.error("onButtonInteraction error:", err);
    }
  });
}

/* ------------------------- Channel helpers ----------------------- */
async function listGuildChannels() {
  if (!DISCORD_GUILD_ID) {
    if (!DISCORD_CHANNEL_ID) throw new Error("Set DISCORD_CHANNEL_ID or DISCORD_GUILD_ID");
    return [{ id: DISCORD_CHANNEL_ID, type: 0, name: "fallback" }];
  }
  const r = await fetch(`${API}/guilds/${DISCORD_GUILD_ID}/channels`, {
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
  });
  if (!r.ok) throw new Error(`[Discord] list channels → ${r.status} ${await r.text()}`);
  return r.json();
}

async function createChannel({ name, type, parent_id }) {
  const r = await fetch(`${API}/guilds/${DISCORD_GUILD_ID}/channels`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, type, parent_id }),
  });
  if (!r.ok) throw new Error(`[Discord] create channel → ${r.status} ${await r.text()}`);
  return r.json();
}

/**
 * Category per seller; child channel is either:
 *  - "confirmation-requests" OR
 *  - "offer-requests"
 */
async function getChannelIdForSeller(sellerNameOrId, kind) {
  const target = kind === "confirm" ? "confirmation-requests" : "offer-requests";

  if (!DISCORD_GUILD_ID) {
    if (!DISCORD_CHANNEL_ID) throw new Error("Set DISCORD_CHANNEL_ID for fallback.");
    return { channelId: DISCORD_CHANNEL_ID, created: false };
  }

  const chans = await listGuildChannels();
  const wanted = String(sellerNameOrId || "").trim();
  const wantedLc = wanted.toLowerCase();

  // Category = type 4
  const cat = chans.find(c => c.type === 4 && String(c.name).trim().toLowerCase() === wantedLc);
  let categoryId = cat?.id;

  if (!categoryId) {
    if (String(ALLOW_CHANNEL_CREATE).toLowerCase() === "true") {
      const createdCat = await createChannel({ name: wanted, type: 4 });
      categoryId = createdCat.id;
    } else {
      throw new Error(`Category "${wanted}" not found and creation disabled`);
    }
  }

  // Text channel (type 0) under the category
  const existing = chans.find(c => c.type === 0 && c.parent_id === categoryId && c.name === target);
  if (existing) return { channelId: existing.id, created: false };

  if (String(ALLOW_CHANNEL_CREATE).toLowerCase() === "true") {
    const created = await createChannel({ name: target, type: 0, parent_id: categoryId });
    return { channelId: created.id, created: true };
  }
  throw new Error(`Channel "${target}" missing under category "${wanted}" and creation disabled`);
}

/* ---------------------- Offer/Confirm messages ------------------- */
/**
 * We expect the Airtable payload to include:
 *  - suggested: seller's original "Selling Price (Suggested)" (VAT regime per seller)
 *  - adjustedMax: the MAX buying price normalized for the seller's VAT regime
 *    (i.e., if seller VAT0 & non-NL → your order max divided by your VAT rate; if seller VAT0 & NL → unchanged)
 *  - vatType, sellerCountry
 *  - sellerVatRatePct (optional, used to DISPLAY "Your Price" as VAT-incl for NL VAT0)
 *  - quantity (optional, displayed only)
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
  adjustedMax,
  vatType,
  sellerCountry,
  sellerVatRatePct, // optional; if omitted we fall back to 21% for NL VAT0 display
  quantity
}) {
  const confirmCase = (
    typeof suggested === "number" &&
    typeof adjustedMax === "number" &&
    suggested <= adjustedMax
  );

  // Offer price is always our adjustedMax when we need to send an offer
  const rawOfferPrice = confirmCase ? suggested : adjustedMax;
  const offerPrice = round2(rawOfferPrice);

  const tag    = vatSuffix({ vatType, sellerCountry });
  const yourDisplayed = displayYourPrice({ suggested, vatType, sellerCountry, sellerVatRatePct });

  const title  = confirmCase ? `📋 Match found for ${sku} / ${size}` : `📑 Offer sent for ${sku} / ${size}`;
  const header = confirmCase ? "🚀 Your Item Matched One Of Our Orders" : "🚨 We Got An Offer For Your Item";

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
    ...(quantity != null ? ["**Quantity**", String(quantity)] : []),
    "**Your Price**\n" + (Number.isFinite(yourDisplayed) ? `€${yourDisplayed.toFixed(2)} ${tag}` : "—"),
  ];

  if (!confirmCase) {
    lines.push("", "**Our Offer**", Number.isFinite(offerPrice) ? `€${offerPrice.toFixed(2)} ${tag}` : "—");
  }

  lines.push("", "**Order**", orderHumanId || orderRecId);

  const description = lines.join("\n");

  const kind = confirmCase ? "confirm" : "offer";
  const { channelId } = await getChannelIdForSeller(sellerName || sellerId, kind);

  if (!channelId) {
    throw new Error(
      `[Discord] No channelId for seller="${sellerName || sellerId}" kind=${kind}.` +
      ` Check DISCORD_GUILD_ID and ALLOW_CHANNEL_CREATE.`
    );
  }
  console.log(`[discord] posting to seller="${sellerName || sellerId}" kind=${kind} channelId=${channelId}`);

  const components = [{
    type: 1,
    components: [
      {
        type: 2, style: 3,
        label: confirmCase ? "Confirm (I have this pair)" : `Accept Offer €${offerPrice.toFixed(2)}`,
        custom_id: `confirm|${orderRecId}|${sellerId}|${inventoryRecordId}|${offerPrice}`
      },
      {
        type: 2, style: 4,
        label: "Deny (Not available)",
        custom_id: `deny|${orderRecId}|${sellerId}|${inventoryRecordId}|${offerPrice}`
      }
    ]
  }];

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
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ embeds: [embed], components }),
  });
  if (!res.ok) throw new Error(`send message → ${res.status} ${await res.text()}`);
  const msg = await res.json();
  return { channelId, messageId: msg.id, offerPrice };
}

/* ------------------- Disable message buttons --------------------- */
export async function disableMessageButtonsGateway(channelId, messageId, note) {
  const r = await fetch(`${API}/channels/${channelId}/messages/${messageId}`, {
    method: "PATCH",
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      components: [{
        type: 1,
        components: [
          { type: 2, style: 2, label: "Confirmed", custom_id: "confirmed", disabled: true },
          { type: 2, style: 2, label: "Denied", custom_id: "denied", disabled: true },
        ]
      }],
      content: note ? `${note}` : undefined,
    }),
  });
  if (!r.ok) throw new Error(`edit message → ${r.status} ${await r.text()}`);
  return r.json();
}
