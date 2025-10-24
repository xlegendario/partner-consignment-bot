import fetch from "node-fetch";
import { verifyKey } from "discord-interactions";

const {
  DISCORD_BOT_TOKEN,
  DISCORD_PUBLIC_KEY,
  DISCORD_GUILD_ID,
  DISCORD_CHANNEL_ID,        // still supported as fallback
  ALLOW_CHANNEL_CREATE
} = process.env;

const API = "https://discord.com/api/v10";

export function verifyDiscordRequest(publicKey) {
  return (req, res, buf) => {
    const sig = req.get("X-Signature-Ed25519");
    const ts  = req.get("X-Signature-Timestamp");
    const ok  = verifyKey(buf, sig, ts, publicKey);
    if (!ok) {
      res.status(401).send("invalid request signature");
      throw new Error("Invalid Discord signature");
    }
  };
}

/** ---- Channel resolution by seller ----
 * Category name: exactly sellerName (case-sensitive match by default)
 * Channel: "confirmation-requests" or "offer-requests"
 * If not found and ALLOW_CHANNEL_CREATE=true → create category/channel.
 */
async function listGuildChannels() {
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
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`[Discord] create channel → ${res.status} ${await res.text()}`);
  return res.json();
}

async function getChannelIdForSeller(sellerName, kind) {
  // kind: "confirm" | "offer"
  const targetChannelName = kind === "confirm" ? "confirmation-requests" : "offer-requests";

  // Fallback to fixed channel if guild id missing
  if (!DISCORD_GUILD_ID) {
    if (!DISCORD_CHANNEL_ID) throw new Error("Set DISCORD_GUILD_ID or DISCORD_CHANNEL_ID");
    return { channelId: DISCORD_CHANNEL_ID, created: false };
  }

  const channels = await listGuildChannels();

  // Find category by name
  const category = channels.find(c => c.type === 4 && c.name === sellerName);
  let categoryId = category?.id;

  if (!categoryId) {
    if (String(ALLOW_CHANNEL_CREATE).toLowerCase() === "true") {
      const cat = await createChannelInGuild({ name: sellerName, type: 4 }); // 4 = GUILD_CATEGORY
      categoryId = cat.id;
    } else {
      throw new Error(`Category not found for seller "${sellerName}" and creation disabled`);
    }
  }

  // Find channel under category
  const channel = channels.find(c => c.type === 0 && c.parent_id === categoryId && c.name === targetChannelName);
  let channelId = channel?.id;

  if (!channelId) {
    if (String(ALLOW_CHANNEL_CREATE).toLowerCase() === "true") {
      const ch = await createChannelInGuild({ name: targetChannelName, type: 0, parent_id: categoryId }); // 0 = text
      channelId = ch.id;
    } else {
      throw new Error(`Channel "${targetChannelName}" missing under "${sellerName}" and creation disabled`);
    }
  }

  return { channelId, created: !channel };
}

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
  const inBetween = [suggested, target, max].every(n => typeof n === "number") &&
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

  // Resolve channel based on seller + kind
  const kind = inBetween ? "confirm" : "offer";
  const { channelId } = await getChannelIdForSeller(sellerName || sellerId, kind);

  const components = [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 3,
          label: inBetween ? "Confirm (I have this pair)" : `Accept Offer €${Number(offerPrice).toFixed(2)}`,
          custom_id: `confirm|${orderRecId}|${sellerId}|${inventoryRecordId}|${offerPrice}`
        },
        {
          type: 2,
          style: 4,
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
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content: `🧾 Match: **${sku} / ${size}**`, embeds: [embed], components })
  });
  if (!res.ok) throw new Error(`[Discord] send message → ${res.status} ${await res.text()}`);
  const msg = await res.json();
  return { ...msg, channel_id: channelId }; // normalize
}

export async function disableMessageButtons(channelId, messageId, note) {
  const res = await fetch(`${API}/channels/${channelId}/messages/${messageId}`, {
    method: "PATCH",
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
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
  if (!res.ok) throw new Error(`[Discord] edit message → ${res.status} ${await res.text()}`);
  return res.json();
}
