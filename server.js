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

/**
 * Health
 */
app.get("/", (req, res) => {
  res.type("text/plain").send("Consignment Discord bot is running.");
});

/**
 * Discord Interactions — MUST verify signature on the RAW body.
 * Do NOT have any global body parsers before this route.
 */
const interactionsJson = express.json({
  verify: (req, res, buf) => {
    const sig = req.get("X-Signature-Ed25519");
    const ts  = req.get("X-Signature-Timestamp");
    const pub = process.env.DISCORD_PUBLIC_KEY;
    const ok  = verifyKey(buf, sig, ts, pub);
    if (!ok) {
      console.error("❌ Invalid Discord signature");
      res.status(401).send("invalid request signature");
      // Throw to stop Express from continuing
      throw new Error("Invalid Discord signature");
    }
  },
});

app.post("/interactions", interactionsJson, async (req, res) => {
  const i = req.body;

  // PING (Discord uses this to verify your endpoint)
  if (i.type === InteractionType.PING) {
    console.log("✅ Discord PING");
    return res.send({ type: 1 });
  }

  if (i.type === InteractionType.MESSAGE_COMPONENT) {
    // custom_id = action|orderRecId|sellerId|inventoryRecordId|offerPrice
    const [action, orderRecId, sellerId, inventoryRecordId, offerPriceStr] =
      String(i.data.custom_id).split("|");
    const offerPrice = Number(offerPriceStr);
    const channelId  = i.channel_id;
    const messageId  = i.message?.id;

    // If already matched → reply ephemeral
    const already = await isOrderAlreadyMatched(orderRecId);
    if (already) {
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "⛔ This order is already matched.", flags: 64 },
      });
    }

    // ACK immediately; do work async
    res.send({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });

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

  // default
  res.send({ type: 1 });
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
