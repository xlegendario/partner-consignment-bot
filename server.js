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
  linkInventoryToOrder
} from "./lib/airtable.js";

const app = express();
app.use(morgan("combined"));

app.get("/", (req, res) => {
  res.type("text/plain").send("Consignment Discord bot is running (gateway mode).");
});

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

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
      // Prefer seller-specific VAT-adjusted targets/max, fallback to order-level
      const adjTarget = typeof s.adjustedTarget === "number" ? s.adjustedTarget : target;
      const adjMax    = typeof s.adjustedMax === "number" ? s.adjustedMax : max;

      console.log("→ sending to Discord", {
        seller: s.sellerName || s.sellerId,
        productName: s.productName,
        vatType: s.vatType,
        sellerCountry: s.sellerCountry,
        adjTarget,
        adjMax,
      });

      // Send to Discord (this builds the embed)
      const { channelId, messageId, offerPrice } = await sendOfferMessageGateway({
        orderRecId,
        orderHumanId,
        sellerId: s.sellerId,
        sellerName: s.sellerName,
        inventoryRecordId: s.inventoryRecordId,
        productName: s.productName || null,
        sku,
        size,
        suggested: s.sellingPriceSuggested,
        target: adjTarget,
        max: adjMax,
      });

      // Log result in Airtable
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


/**
 * External webhook to disable offers if order becomes matched externally.
 * Example body: { orderRecId: "recXXXXXXXX", reason: "Fulfilled manually" }
 */
app.post("/disable-offers", async (req, res) => {
  try {
    const { orderRecId, reason } = req.body || {};
    if (!orderRecId) return res.status(400).json({ error: "Missing orderRecId" });

    console.log(`🔄 External disable for order ${orderRecId} — reason: ${reason || "unknown"}`);

    // Fetch all Discord messages logged for that order
    const msgs = await listOfferMessagesForOrder(orderRecId);
    if (!msgs?.length) {
      return res.json({ ok: true, message: "No messages found for this order." });
    }

    await Promise.allSettled(
      msgs.map(m =>
        disableMessageButtonsGateway(
          m.channelId,
          m.messageId,
          `✅ Another seller matched. Offers closed.`
        )
      )
    );

    res.json({ ok: true, disabled: msgs.length });
  } catch (err) {
    console.error("Error in /disable-offers:", err);
    res.status(500).json({ error: err.message });
  }
});


// 404
app.use((req, res) => res.status(404).json({ error: "Not found" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("HTTP listening on :" + PORT));

await initDiscord();

await onButtonInteraction(async ({ action, orderRecId, sellerId, inventoryRecordId, offerPrice, channelId, messageId }) => {
  try {
    const already = await isOrderAlreadyMatched(orderRecId);
    if (already) {
      await disableMessageButtonsGateway(channelId, messageId, "⛔ Already matched. Buttons disabled.");
      return;
    }

    if (action === "confirm") {
      await linkInventoryToOrder(inventoryRecordId, orderRecId);
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
