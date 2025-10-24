import express from "express";
import morgan from "morgan";
import { InteractionType, InteractionResponseType } from "discord-interactions";
import { verifyDiscordRequest, sendOfferMessage, disableMessageButtons } from "./lib/discord.js";
import { setInventorySold, setOrderMatched, isOrderAlreadyMatched, logOfferMessage, listOfferMessagesForOrder } from "./lib/airtable.js";

const app = express();

// Standard body parsers for normal routes
app.use(morgan("combined"));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  res.type("text/plain").send("Consignment Discord bot is running.");
});

/**
 * Airtable → Offers
 * Body: your payload (order + sellers[])
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
        max
      });

      // Compute offer price same way as in sendOfferMessage
      const inBetween = [s.sellingPriceSuggested, target, max].every(n => typeof n === "number") &&
                        s.sellingPriceSuggested >= target && s.sellingPriceSuggested <= max;
      const offerPrice = inBetween ? s.sellingPriceSuggested : max;

      await logOfferMessage({
        orderRecId,
        sellerId: s.sellerId,
        inventoryRecordId: s.inventoryRecordId,
        channelId: msg.channel_id,
        messageId: msg.id,
        offerPrice
      });

      results.push({ sellerId: s.sellerId, messageId: msg.id });
    }

    res.json({ ok: true, sentCount: results.length, sent: results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * Discord Interactions (button clicks)
 * Set Discord "Interactions Endpoint URL" to: https://<your-app>.onrender.com/interactions
 * Needs RAW body to verify signature, then we parse JSON.
 */
app.post(
  "/interactions",
  express.raw({ type: "*/*" }),
  (req, res, next) => {
    try { verifyDiscordRequest(process.env.DISCORD_PUBLIC_KEY)(req, res, req.body); next(); }
    catch (e) { /* verifyDiscordRequest already responded 401 */ }
  },
  express.json(),
  async (req, res) => {
    const i = req.body;

    if (i.type === InteractionType.PING) {
      return res.send({ type: 1 });
    }

    if (i.type === InteractionType.MESSAGE_COMPONENT) {
      // custom_id = action|orderRecId|sellerId|inventoryRecordId|offerPrice
      const [action, orderRecId, sellerId, inventoryRecordId, offerPriceStr] = String(i.data.custom_id).split("|");
      const offerPrice = Number(offerPriceStr);
      const channelId = i.channel_id;
      const messageId = i.message?.id;

      // Idempotency: if already matched, reply ephemeral
      const already = await isOrderAlreadyMatched(orderRecId);
      if (already) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "⛔ This order is already matched.", flags: 64 }
        });
      }

      // ACK now; do heavy work after
      res.send({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });

      try {
        if (action === "confirm") {
          // 1) Update Inventory record: sold + final price
          await setInventorySold(inventoryRecordId, offerPrice);
          // 2) Mark Order as Matched
          await setOrderMatched(orderRecId);
          // 3) Disable ALL offer messages for this order
          const msgs = await listOfferMessagesForOrder(orderRecId);
          await Promise.allSettled(
            msgs.map(m => disableMessageButtons(m.channelId, m.messageId, `✅ Matched by ${sellerId}. Offers closed.`))
          );
        } else if (action === "deny") {
          // Disable just this message
          await disableMessageButtons(channelId, messageId, `❌ ${sellerId} denied / not available.`);
        }
      } catch (e) {
        console.error("Interaction handling error:", e);
      }
      return;
    }

    // default
    res.send({ type: 1 });
  }
);

// 404
app.use((req, res) => res.status(404).json({ error: "Not found" }));

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Listening on :" + PORT));
