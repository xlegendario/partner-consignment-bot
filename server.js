// server.js
import express from "express";
import morgan from "morgan";
import { verifyKey, InteractionType, InteractionResponseType } from "discord-interactions";
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

// Log PK suffix so we know we're using the same app's Public Key
console.log("DISCORD_PUBLIC_KEY suffix:", (process.env.DISCORD_PUBLIC_KEY || "").slice(-8));

/**
 * Health
 */
app.get("/", (req, res) => {
  res.type("text/plain").send("Consignment Discord bot is running.");
});

/**
 * Discord Interactions (verification must read RAW body)
 * IMPORTANT: No global body parsers before this route.
 */
function verifyDiscordRequestRaw(req, res, buf) {
  const sig = req.get("X-Signature-Ed25519");
  const ts  = req.get("X-Signature-Timestamp");
  const pub = process.env.DISCORD_PUBLIC_KEY;

  if (!sig || !ts || !pub) {
    res.status(401).type("text/plain").send("missing signature headers/public key");
    throw new Error("Missing signature headers or public key");
  }

  const ok = verifyKey(buf, sig, ts, pub);
  if (!ok) {
    console.error("❌ Invalid Discord signature");
    res.status(401).type("text/plain").send("invalid request signature");
    throw new Error("Invalid Discord signature");
  }
}

// Primary interactions endpoint — RAW parser
app.post(
  "/interactions",
  express.raw({ type: "*/*" }),
  (req, res, next) => {
    try { verifyDiscordRequestRaw(req, res, req.body); next(); }
    catch { /* response already sent on failure */ }
  },
  async (req, res) => {
    // Now safely parse the verified raw JSON
    let interaction = {};
    try {
      interaction = JSON.parse(req.body.toString("utf8") || "{}");
    } catch {
      // If it isn't JSON, just ACK type 1 to be safe
      res.set("Content-Type", "application/json; charset=utf-8");
      return res.status(200).send('{"type":1}');
    }

    // PING (Discord uses this to verify your endpoint)
    if (interaction.type === InteractionType.PING) {
      console.log("✅ Discord PING (/interactions)");
      res.set("Content-Type", "application/json; charset=utf-8");
      return res.status(200).send('{"type":1}');
    }

    if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
      // custom_id = action|orderRecId|sellerId|inventoryRecordId|offerPrice
      const [action, orderRecId, sellerId, inventoryRecordId, offerPriceStr] =
        String(interaction.data?.custom_id || "").split("|");
      const offerPrice = Number(offerPriceStr);
      const channelId  = interaction.channel_id;
      const messageId  = interaction.message?.id;

      // If already matched → reply ephemeral
      const already = await isOrderAlreadyMatched(orderRecId);
      if (already) {
        res.set("Content-Type", "application/json; charset=utf-8");
        return res.status(200).send(JSON.stringify({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "⛔ This order is already matched.", flags: 64 }
        }));
      }

      // ACK immediately (Deferred response)
      res.set("Content-Type", "application/json; charset=utf-8");
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

    // Default ACK (rare)
    res.set("Content-Type", "application/json; charset=utf-8");
    return res.status(200).send('{"type":1}');
  }
);

/**
 * Optional alternate path (some users report the portal prefers a different path)
 * Uses the exact same raw verification and minimal PING ack.
 */
app.post(
  "/discord/interactions",
  express.raw({ type: "*/*" }),
  (req, res, next) => {
    try { verifyDiscordRequestRaw(req, res, req.body); next(); }
    catch { /* already responded */ }
  },
  (req, res) => {
    // Minimal "it works" handler: always PING-ACK
    try {
      const i = JSON.parse(req.body.toString("utf8") || "{}");
      if (i?.type === InteractionType.PING) {
        console.log("✅ Discord PING (/discord/interactions)");
      }
    } catch {}
    res.set("Content-Type", "application/json; charset=utf-8");
    return res.status(200).send('{"type":1}');
  }
);

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
