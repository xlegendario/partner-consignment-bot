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
  client = new Client({ intents: [GatewayIntentBits.Guilds] }); // minimal to avoid disallowed intents
  await client.login(DISCORD_BOT_TOKEN);
  console.log("✅ Discord logged in as", client.user?.tag);
  return client;
}

export async function onButtonInteraction(handler) {
  await initDiscord();
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;
    await interaction.deferUpdate().catch(() => {}); // ack immediately
    try {
      const [action, orderRecId, sellerId, inventoryRecordId, offerPriceStr] =
        String(interaction.customId).split("|");
      const offerPrice = Number(offerPriceStr);
      await handler({
        action, orderRecId, sellerId, inventoryRecordId, offerPrice,
        channelId: interaction.channelId,
        messageId: interaction.message?.id,
      });
    } catch (e) { console.error("onButtonInteraction error:", e); }
  });
}

/* -------------------- Channel helpers -------------------- */
async function listGuildChannels() {
  if (!DISCORD_GUILD_ID) {
    if (!DISCORD_CHANNEL_ID) throw new Error("Set DISCORD_CHANNEL_ID or DISCORD_GUILD_ID");
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
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, type, parent_id })
  });
  if (!r.ok) throw new Error(`create channel → ${r.status} ${await r.text()}`);
  return r.json();
}
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
    } else throw new Error(`Missing category "${sellerNameOrId}"`);
  }
  const ch = chans.find(c => c.type === 0 && c.parent_id === categoryId && c.name === target);
  if (ch) return { channelId: ch.id, created: false };
  if (String(ALLOW_CHANNEL_CREATE).toLowerCase() === "true") {
    const created = await createChannel({ name: target, type: 0, parent_id: categoryId });
    return { channelId: created.id, created: true };
  }
  throw new Error(`Missing channel "${target}" under "${sellerNameOrId}"`);
}

/* -------------------- Price helpers + labels -------------------- */
const euro = (v) => (typeof v === "number" && isFinite(v) ? `€${v.toFixed(2)}` : "—");

const shouldConfirm = (suggested, adjustedMax) =>
  [suggested, adjustedMax].every(n => typeof n === "number") && suggested <= adjustedMax;

function vatSuffix({ vatType, sellerCountry, clientCountry }) {
  const vt = String(vatType || "").toUpperCase();
  const isNL = (s) => String(s || "").toLowerCase().includes("nether");
  const bothDutch = isNL(sellerCountry) && isNL(clientCountry);

  if (vt.includes("MARGIN")) return "(Margin)";
  if (vt.includes("VAT21"))  return "(VAT 21%)";
  if (vt.includes("VAT0"))   return bothDutch ? "(VAT 21%)" : "(VAT 0%)";
  return "";
}

/* -------------------- Send / Disable -------------------- */
export async function sendOfferMessageGateway({
  orderRecId,
  orderHumanId,
  sellerId,
  sellerName,
  inventoryRecordId,
  productName,
  sku,
  size,
  suggested,          // seller's ask (as sent from Airtable; already normalized if needed)
  adjustedMax,        // max we buy (normalized; incl/excl VAT as per your logic)
  vatType,
  sellerCountry,
  clientCountry,
  showMax = true,// for label tag only
}) {
  // ---------- helpers ----------
  const shouldConfirm = (s, m) =>
    [s, m].every(n => typeof n === "number" && isFinite(n)) && s <= m;

  const vatSuffix = ({ vatType, sellerCountry, clientCountry }) => {
    const vt = String(vatType || "").toUpperCase();
    const isNL = (s) => String(s || "").toLowerCase().includes("nether");
    const bothDutch = isNL(sellerCountry) && isNL(clientCountry);
    if (vt.includes("MARGIN")) return "(Margin)";
    if (vt.includes("VAT21"))  return "(VAT 21%)";
    if (vt.includes("VAT0"))   return bothDutch ? "(VAT 21%)" : "(VAT 0%)";
    return "";
  };

  // ---------- compute offer/confirm case ----------
  const confirmCase = shouldConfirm(suggested, adjustedMax);
  const offerPrice  = confirmCase
    ? suggested
    : (typeof adjustedMax === "number" ? adjustedMax : null);

  const yourTag = vatSuffix({ vatType, sellerCountry, clientCountry });
  const ourTag  = vatSuffix({ vatType, sellerCountry, clientCountry });

  // One-line header ABOVE the embed (message content)
  const contentHeader = confirmCase
    ? `📋 Match found for ${sku} / ${size}`
    : `📑 Offer sent for ${sku} / ${size}`;

  // Title INSIDE the embed
  const embedTitle = confirmCase
    ? "🚀 Your Item Matched One Of Our Orders"
    : "💸 We Got An Offer For Your Item";

  // Short description (no quantity)
  const descLines = [
    "If you still have this pair, click **Confirm** below. FCFS — other sellers might also have this listed.",
    "",
    "**Product Name**",
    productName || "—",
    "",
    `**SKU**\n${sku ?? "—"}`,
    `**Size**\n${size ?? "—"}`,
    "",
    "**Order**",
    orderHumanId || orderRecId || "—",
  ];
  const description = descLines.join("\n");

  // Inline fields for side-by-side layout
  const yourValue = (suggested != null && isFinite(suggested))
    ? `€${Number(suggested).toFixed(2)} ${yourTag}`
    : "—";

  // For confirm messages we show our cap (“Max We Buy”)
  const rightLabel = confirmCase ? "Max We Buy" : "Our Offer";
  const rightNumber = confirmCase ? adjustedMax : offerPrice;
  const rightValue = (rightNumber != null && isFinite(rightNumber))
    ? `€${Number(rightNumber).toFixed(2)} ${ourTag}`
    : "—";

  const fields = [const fields = [{ name: "Your Price", value: yourValue, inline: true }];
  // Only show a right column when we're sending an offer (not a confirm),
  // and only if showMax wasn't explicitly disabled.
  if (!confirmCase) {
    const rightLabel  = "Our Offer";
    const rightNumber = offerPrice;
    const rightValue  = (rightNumber != null && isFinite(rightNumber))
      ? `€${Number(rightNumber).toFixed(2)} ${ourTag}`
      : "—";
    fields.push({ name: rightLabel, value: rightValue, inline: true });
  } else if (showMax && adjustedMax != null && isFinite(adjustedMax)) {
    // (Optional) if you ever want to show it again for confirms, the guard allows it.
    const rightValue = `€${Number(adjustedMax).toFixed(2)} ${ourTag}`;
    fields.push({ name: "Max We Buy", value: rightValue, inline: true });
  }
  ];

  // Find (or create) the channel under the seller's category
  const kind = confirmCase ? "confirm" : "offer";
  const { channelId } = await getChannelIdForSeller(sellerName || sellerId, kind);
  if (!channelId) {
    throw new Error(
      `[Discord] No channelId resolved for seller="${sellerName || sellerId}", ` +
      `kind=${kind}. Check DISCORD_GUILD_ID and ALLOW_CHANNEL_CREATE.`
    );
  }
  console.log(`[discord] posting to seller="${sellerName || sellerId}" kind=${kind} channelId=${channelId}`);

  // Buttons
  const acceptLabel = confirmCase
    ? "Confirm"
    : `Accept Offer €${(offerPrice != null && isFinite(offerPrice)) ? Number(offerPrice).toFixed(2) : "—"}`;

  const components = [{
    type: 1,
    components: [
      {
        type: 2, style: 3,
        label: acceptLabel,
        custom_id: `confirm|${orderRecId}|${sellerId}|${inventoryRecordId}|${offerPrice ?? 0}`
      },
      {
        type: 2, style: 4,
        label: "Deny",
        custom_id: `deny|${orderRecId}|${sellerId}|${inventoryRecordId}|${offerPrice ?? 0}`
      }
    ]
  }];

  // Embed
  const embed = {
    title: embedTitle,
    description,
    color: confirmCase ? 0x2ecc71 : 0xf1c40f,
    fields,
    footer: { text: `SellerID: ${sellerId}` },
    timestamp: new Date().toISOString()
  };

  // Send message (content header + embed)
  const res = await fetch(`${API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      content: contentHeader,
      embeds: [embed],
      components
    })
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
