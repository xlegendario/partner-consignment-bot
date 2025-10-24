// server.js
import express from "express";
import morgan from "morgan";
import {
  initDiscord,
  sendOfferMessageGateway,
  disableMessageButtonsGateway,
  onButtonInteraction
} from "./lib/discord.js";
import {
  setInventorySold,
  setOrderMatched,
  isOrderAlreadyMatched,
  logOfferMessage,
  listOfferMessagesForOrder,
} from "./lib/airtable.js";

const app = express();
app.use(morgan("combined"));

/** Health */
app.get("/", (req, res) => {
  res.type("text/plain").send("Consignment Discord bot is running (gateway mode).");
});

/** Normal parsers for HTTP routes */
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

/** Airtable → Offers (order + sellers[]) */
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
      const { channelId, messageId, offerPrice } = await sendOfferMessageGateway({
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

      await logOfferMessage({
        orderRecId,
        sellerId: s.sellerId,
        inventoryRecordId: s.inventoryRecordId,
        channelId,
        messageId,
        offerPrice,
      });

      results.push({ sellerId: s.sellerId, messageId });
    }

    res.json({ ok: true, sentCount: results.length, sent: results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// 404
app.use((req, res) => res.status(404).json({ error: "Not found" }));

/** Start everything */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("HTTP listening on :" + PORT));

/** Initialize Discord first, then attach the interaction handler */
const client = await initDiscord();

await onButtonInteraction(async ({ action, orderRecId, sellerId, inventoryRecordId, offerPrice, channelId, messageId }) => {
  try {
    const already = await isOrderAlreadyMatched(orderRecId);
    if (already) {
      await disableMessageButtonsGateway(channelId, messageId, "⛔ Already matched. Buttons disabled.");
      return;
    }

    if (action === "confirm") {
      await setInventorySold(inventoryRecordId, offerPrice);
      await setOrderMatched(orderRecId);

      const msgs = await listOfferMessagesForOrder(orderRecId);
      await Promise.allSettled(
        msgs.map(m =>
          disableMessageButtonsGateway(
            m.channelId,
            m.messageId,
            `✅ Matched by ${sellerId}. Offers closed.`
          )
        )
      );
    } else if (action === "deny") {
      await disableMessageButtonsGateway(
        channelId,
        messageId,
        `❌ ${sellerId} denied / not available.`
      );
    }
  } catch (err) {
    console.error("Interaction handling error:", err);
  }
});
