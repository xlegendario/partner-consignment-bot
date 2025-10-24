// server.js
import express from "express";
import morgan from "morgan";
import { InteractionType, InteractionResponseType, verifyKey } from "discord-interactions";
import { sendOfferMessage, disableMessageButtons } from "./lib/discord.js";
import {
  setInventorySold,
  setOrderMatched,
  isOrderAlreadyMatched,
  logOfferMessage,
  listOfferMessagesForOrder,
} from "./lib/airtable.js";

const app = express();
app.use(morgan("combined"));

// Log PK suffix at boot to ensure we're using the right app's public key
console.log("DISCORD_PUBLIC_KEY suffix:", (process.env.DISCORD_PUBLIC_KEY || "").slice(-8));

/**
 * Health
 */
app.get("/", (req, res) => {
  res.type("text/plain").send("Consignment Discord bot is running.");
});

/**
 * Discord Interactions — MUST verify signature on the RAW body.
 * Do NOT have any global body parsers before these routes.
 */
const interactionsJson = express.json({
  verify: (req, res, buf) => {
    const sig = req.get("X-Signature-Ed25519");
    const ts  = req.get("X-Signature-Timestamp");
    const pub = process.env.DISCORD_PUBLIC_KEY;

    // Small debug to see Discord headers
    // (safe to keep; doesn't log secrets)
    // console.log("INT headers:", "sig.len", sig ? sig.length : 0, "ts", ts);

    const ok  = verifyKey(buf, sig, ts, pub);
    if (!ok) {
      console.error("❌ Invalid Discord signature");
      res.status(401).type("text/plain").send("invalid request signature");
      throw new Error("Invalid Discord signature");
    }
  },
});

// Primary interactions endpoint
app.post("/interactions", interactionsJson, async (req, res) => {
  const i = req.body;

  // PING (Discord uses this to verify your endpoint)
  if (i?.type === InteractionType.PING) {
    console.log("✅ Discord PING (/interactions)");
    res.set("Content-Type", "application/json");
    return res.status(200).send('{"type":1}');
  }

  if (i?.type === InteractionType.MESSAGE_COMPONENT) {
    // custom_id = action|orderRecId|sellerId|inventoryRecordId|offerPrice
    const [action, orderRecId, sellerId, inventoryRecordId, offerPriceStr] =
      String(i.data.custom_id).split("|");
    const offerPrice = Number(offerPriceStr);
    const channelId  = i.channel_id;
    const messageId  = i.message?.id;

    // If already matched → reply ephemeral
    const already = await isOrderAlreadyMatched(orderRecId);
    if (already) {
      res.set("Content-Type", "application/json");
      return res.status(200).send(JSON.stringify({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "⛔ This order is already matched.", flags: 64 }
      }));
    }

    // ACK immediately; do work async
    res.set("Content-Type", "application/json");
    res.status(200).send('{"type":5}'); // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE

    try {
      if (action === "confirm") {
        await setInventorySold(inventoryRecordId, offerPrice);
        await setOrderMatched(orderRecId);

        const msgs = await listOfferMessagesForOrder(orderRecId);
        await Promise.allSettled(
          msgs.map(m =>
            disableMessageButtons(
              m.channelId,
              m.messageId,
              `✅ Matched by ${sellerId}. Offers closed.`
            )
          )
        );
      } else if (action === "deny") {
        await disableMessageButtons(
          channelId,
          messageId,
          `❌ ${sellerId} denied / not available.`
        );
      }
    } catch (err) {
      console.error("Interaction handling error:", err);
    }
    return;
  }

  // default no-op ACK
  res.set("Content-Type", "application/json");
  return res.status(200).send('{"type":1}');
});

// Alternate interactions endpoint (sometimes the portal prefers a different path)
app.post("/discord/interactions", interactionsJson, async (req, res) => {
  const i = req.body;

  if (i?.type === InteractionType.PING) {
    console.log("✅ Discord PING (/discord/interactions)");
    res.set("Content-Type", "application/json");
    return res.status(200).send('{"type":1}');
  }

  // Just ACK for now; if you want, you can duplicate the component logic here too.
  res.set("Content-Type", "application/json");
  return res.status(200).send('{"type":1}');
});

/**
 * Normal parsers for all OTHER routes go AFTER /interactions
 */
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

/**
 * Airtable → Offers (order + sellers[])
 */
app.post("/offers", async (req, res) => {
  try {
    const p = req.body || {};
    const orderRecId   = p?.order?.airtableRecordId;
    const orderHumanId = p?.order?.orderId;
    const sku          = p?.order?.sku;
    const size         = p?.order?.size;
    const target       = p?.order?.targetBuyingPrice;
    const max          = p?.order?.maximumBuyingPrice;
    const sellers      = Array.isArray(p?.sellers) ? p.sellers : [];

    if (!orderRecId || sellers.length === 0) {
      return res.status(400).json({ error: "Missing order or sellers in payload" });
    }

    const results = [];
    for (const s of sellers) {
      const msg = await sendOfferMessage({
        orderRecId,
        orderHumanId,
        sellerId: s.sellerId,
        sellerName: s.sellerName,
        inventoryRecordId: s.inventoryRecordId,
        sku,
        size,
        suggested: s.sellingPriceSuggested,
        target,
        max,
      });

      const inBetween =
        [s.sellingPriceSuggested, target, max].every(n => typeof n === "number") &&
        s.sellingPriceSuggested >= target &&
        s.sellingPriceSuggested <= max;

      const offerPrice = inBetween ? s.sellingPriceSuggested : max;

      await logOfferMessage({
        orderRecId,
        sellerId: s.sellerId,
        inventoryRecordId: s.inventoryRecordId,
        channelId: msg.channel_id,
        messageId: msg.id,
        offerPrice,
      });

      results.push({ sellerId: s.sellerId, messageId: msg.id });
    }

    res.json({ ok: true, sentCount: results.length, sent: results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// 404
app.use((req, res) => res.status(404).json({ error: "Not found" }));

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Listening on :" + PORT));
