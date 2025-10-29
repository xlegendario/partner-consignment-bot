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

let client;
export async function initDiscord() {
  if (client) return client;
  client = new Client({
    intents: [GatewayIntentBits.Guilds], // minimal to avoid disallowed intents
  });
  await client.login(DISCORD_BOT_TOKEN);
  console.log("✅ Discord logged in as", client.user?.tag);
  return client;
}

export async function onButtonInteraction(handler) {
  await initDiscord();
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;
    // ACK immediately so we don't double-ack later
    await interaction.deferUpdate().catch(() => {});
    try {
      // custom_id = action|orderRecId|sellerId|inventoryRecordId|offerPrice
      const [action, orderRecId, sellerId, inventoryRecordId, offerPriceStr] =
        String(interaction.customId).split("|");
      const offerPrice = Number(offerPriceStr);
      await handler({
        action, orderRecId, sellerId, inventoryRecordId, offerPrice,
        channelId: interaction.channelId,
        messageId: interaction.message?.id,
      });
    } catch (e) {
      console.error("onButtonInteraction error:", e);
    }
  });
}

/* ----------------- Channel helpers ----------------- */
async function listGuildChannels() {
  if (!DISCORD_GUILD_ID) {
    if (!DISCORD_CHANNEL_ID) throw new Error("Set DISCORD_CHANNEL_ID or DISCORD_GUILD_ID");
    return [{ id: DISCORD_CHANNEL_ID, type: 0, name: "fallback" }];
  }
  const r = await fetch(`${API}/guilds/${DISCORD_GUILD_ID}/channels`, {
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
  });
  if (!r.ok) throw new Error(`[Discord] list channels → ${r.status} ${await r.text()}`);
  return r.json();
}
async function createChannel({ name, type, parent_id }) {
  const r = await fetch(`${API}/guilds/${DISCORD_GUILD_ID}/channels`, {
    method: "POST",
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, type, parent_id })
  });
  if (!r.ok) throw new Error(`[Discord] create channel → ${r.status} ${await r.text()}`);
  return r.json();
}
/** Category = seller name; text channel = offer-requests / confirmation-requests */
async function getChannelIdForSeller(sellerNameOrId, kind) {
  const target = kind === "confirm" ? "confirmation-requests" : "offer-requests";
  if (!DISCORD_GUILD_ID) return { channelId: DISCORD_CHANNEL_ID, created: false };

  const chans = await listGuildChannels();
  const wanted = String(sellerNameOrId || "").trim().toLowerCase();

  const cat = chans.find(c => c.type === 4 && String(c.name).trim().toLowerCase() === wanted);
  let categoryId = cat?.id;
  if (!categoryId) {
    if (String(ALLOW_CHANNEL_CREATE).toLowerCase() === "true") {
      categoryId = (await createChannel({ name: sellerNameOrId, type: 4 })).id;
    } else {
      throw new Error(`Category not found for seller "${sellerNameOrId}" and creation disabled`);
    }
  }
  const ch = chans.find(c => c.type === 0 && c.parent_id === categoryId && c.name === target);
  if (ch) return { channelId: ch.id, created: false };
  if (String(ALLOW_CHANNEL_CREATE).toLowerCase() === "true") {
    const created = await createChannel({ name: target, type: 0, parent_id: categoryId });
    return { channelId: created.id, created: true };
  }
  throw new Error(`Channel "${target}" missing under "${sellerNameOrId}" and creation disabled`);
}

/* ----------------- VAT & decision logic ----------------- */
const pct = (x) => {
  const n = Number(x) || 0;
  return n > 1 ? n/100 : n;  // 21 → 0.21 ; 0.21 → 0.21
};
const isNL = (s) => String(s || "").toLowerCase().includes("nether");
const vatSuffix = ({ vt, bothNL }) => {
  if (vt.includes("MARGIN")) return "(Margin)";
  if (vt.includes("VAT21"))  return "(VAT 21%)";
  if (vt.includes("VAT0"))   return bothNL ? "(VAT 21%)" : "(VAT 0%)";
  return "";
};

/**
 * ≤ max → confirm ; > max → offer
 * NL-VAT0 seller is compared as suggested×(1+rate)
 * non-NL VAT0 compares to order's VAT0 bounds (target/max ÷ (1+rate))
 */
export async function sendOfferMessageGateway({
  orderRecId, orderHumanId,
  sellerId, sellerName, inventoryRecordId,
  productName, sku, size,
  suggested, target, max,
  vatType, sellerCountry, clientCountry, clientVatRate,
  quantity
}) {
  const vt = String(vatType || "").toUpperCase();
  const isMargin = vt.includes("MARGIN");
  const isVat21  = vt.includes("VAT21");
  const isVat0   = vt.includes("VAT0");
  const bothDutch = isNL(sellerCountry) && isNL(clientCountry);
  const rate = pct(clientVatRate);

  let sellerCompare = Number(suggested);
  let orderTargetN  = Number(target);
  let orderMaxN     = Number(max);

  if (isVat0 && bothDutch) {
    sellerCompare = Number(suggested) * (1 + rate);        // VAT0 (NL) → compare as VAT21
  } else if (isVat0 && !bothDutch) {
    orderTargetN = Number(target) / (1 + rate);            // compare in VAT0
    orderMaxN    = Number(max)    / (1 + rate);
  }
  // Margin & VAT21 → compare as-is (already VAT-included)

  const confirmCase = (
    [sellerCompare, orderMaxN].every(n => Number.isFinite(n)) &&
    sellerCompare <= orderMaxN
  );

  let offerPrice = null;
  if (!confirmCase) {
    // show offer in the seller's regime
    offerPrice = (isVat0 && !bothDutch) ? (Number(max) / (1 + rate)) : Number(max);
  }

  const yourLabel = vatSuffix({ vt, bothNL: bothDutch });
  const ourLabel  = vatSuffix({ vt, bothNL: bothDutch });

  const yourDisplay = (isVat0 && bothDutch)
    ? (Number(suggested) * (1 + rate))
    : Number(suggested);

  const title  = confirmCase ? `📋 Match found for ${sku} / ${size}` : `📑 Offer sent for ${sku} / ${size}`;
  const header = confirmCase ? "🚀 Your Item Matched One Of Our Orders"
                             : "🚨 We Got An Offer For Your Item";

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
    "**Your Price**\n" + (Number.isFinite(yourDisplay) ? `€${yourDisplay.toFixed(2)} ${yourLabel}` : "—"),
  ];

  if (!confirmCase) {
    lines.push(
      "",
      "**Our Offer**",
      (offerPrice != null && Number.isFinite(offerPrice))
        ? `€${offerPrice.toFixed(2)} ${ourLabel}`
        : "—"
    );
  }

  lines.push("", "**Order**", orderHumanId || orderRecId);
  const description = lines.join("\n");

  const kind = confirmCase ? "confirm" : "offer";
  const { channelId } = await getChannelIdForSeller(sellerName || sellerId, kind);
  if (!channelId) throw new Error(`[Discord] No channelId resolved for seller="${sellerName || sellerId}"`);
  console.log(`[discord] posting to seller="${sellerName || sellerId}" kind=${kind} channelId=${channelId}`);

  const components = [{
    type: 1,
    components: [
      {
        type: 2, style: 3,
        label: confirmCase ? "Confirm (I have this pair)"
                           : `Accept Offer €${offerPrice?.toFixed(2) ?? "—"}`,
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
