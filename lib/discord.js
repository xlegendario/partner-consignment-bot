import fetch from "node-fetch";
import { verifyKey } from "discord-interactions";

const {
  DISCORD_BOT_TOKEN,
  DISCORD_PUBLIC_KEY,
  DISCORD_CHANNEL_ID
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

export async function sendOfferMessage({
  channelId = DISCORD_CHANNEL_ID,
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
  return res.json(); // includes id, channel_id
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
