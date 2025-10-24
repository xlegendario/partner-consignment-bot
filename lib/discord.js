// lib/discord.js
import fetch from "node-fetch";
import { verifyKey } from "discord-interactions";

const {
  DISCORD_BOT_TOKEN,
  DISCORD_PUBLIC_KEY,     // used in server.js verify hook
  DISCORD_GUILD_ID,       // server id (recommended)
  DISCORD_CHANNEL_ID,     // fallback: single channel if you don't use categories
  ALLOW_CHANNEL_CREATE    // "true" to allow auto-creation of categories/channels
} = process.env;

const API = "https://discord.com/api/v10";

// ----------------------
// Utilities (channels)
// ----------------------

async function listGuildChannels() {
  if (!DISCORD_GUILD_ID) {
    throw new Error("DISCORD_GUILD_ID is not set (required for per-seller categories).");
  }
  const res = await fetch(`${API}/guilds/${DISCORD_GUILD_ID}/channels`, {
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
  });
  if (!res.ok) throw new Error(`[Discord] list channels → ${res.status} ${await res.text()}`);
  return res.json();
}

async function createChannelInGuild({ name, type, parent_id }) {
  const body = { name, type };
  if (parent_id) body.parent_id = parent_id; // must be category id when creating a text channel under it
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
 * - Category name must match seller name/id case-insensitively.
 * - Channel name is "confirmation-requests" or "offer-requests".
 * Returns { channelId, created }
 */
async function getChannelIdForSeller(sellerNameOrId, kind) {
  // kind: "confirm" | "offer"
  const targetChannelName = kind === "confirm" ? "confirmation-requests" : "offer-requests";

  // Fallback single-channel mode if you didn't set a guild
  if (!DISCORD_GUILD_ID) {
    if (!DISCORD_CHANNEL_ID) {
      throw new Error("Set DISCORD_GUILD_ID (recommended) or DISCORD_CHANNEL_ID (fallback).");
    }
    return { channelId: DISCORD_CHANNEL_ID, created: false };
  }

  const channels = await listGuildChannels();

  // ---- Case-insensitive category match
  const wanted = (sellerNameOrId || "").trim();
  const wantedLc = wanted.toLowerCase();

  const category = channels.find(
    c => c.type === 4 && typeof c.name === "string" && c.name.trim().toLowerCase() === wantedLc
  );
  let categoryId = category?.id;

  if (!categoryId) {
    if (String(ALLOW_CHANNEL_CREATE).toLowerCase() === "true") {
      // Create category with original casing
      const cat = await createChannelInGuild({ name: wanted, type: 4 }); // 4 = GUILD_CATEGORY
      categoryId = cat.id;
    } else {
      throw new Error(`Category not found for seller "${wanted}" (case-insensitive) and creation disabled`);
    }
  }

  // Find text channel under category (0 = GUILD_TEXT)
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

// ----------------------
// Public API
// ----------------------

/**
 * Send an offer/confirmation message for a seller.
 * Buttons have custom_id: "confirm|orderRecId|sellerId|inventoryRecordId|offerPrice"
 * or "deny|..."
 */
export async function sendOfferMessage({
  orderRecId,
  orderHumanId,
  sellerId,
  sellerName,
  inventoryRecordId,
  sku,
  size,
  suggested,
  target,
  max
}) {
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

  // Resolve the per-seller channel
  const kind = inBetween ? "confirm" : "offer";
  const { channelId } = await getChannelIdForSeller(sellerName || sellerId, kind);

  const components = [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 3, // green
          label: inBetween ? "Confirm (I have this pair)" : `Accept Offer €${Number(offerPrice).toFixed(2)}`,
          custom_id: `confirm|${orderRecId}|${sellerId}|${inventoryRecordId}|${offerPrice}`
        },
        {
          type: 2,
          style: 4, // red
          label: "Deny (Not available)",
          custom_id: `deny|${orderRecId}|${sellerId}|${inventoryRecordId}|${offerPrice}`
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
    body: JSON.stringify({
      content: `🧾 Match: **${sku} / ${size}**`,
      embeds: [embed],
      components
    })
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`[Discord] send message → ${res.status} ${t}`);
  }

  const msg = await res.json();
  // Normalize channel_id because when posting to a channel endpoint, some libs omit it
  return { ...msg, channel_id: channelId };
}

/**
 * Disable buttons on a message and optionally add a note.
 */
export async function disableMessageButtons(channelId, messageId, note) {
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

// (Optional) export for completeness if you want to use it directly;
// server.js currently verifies with a route-specific verify hook.
export { verifyKey };
