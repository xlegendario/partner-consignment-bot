// server.js
import express from "express";
import morgan from "morgan";
import {
  initDiscord,
  onButtonInteraction,
  sendOfferMessageGateway,
  disableMessageButtonsGateway,
} from "./lib/discord.js";
import {
  logOfferMessage,
  listOfferMessagesForOrder,
  createSaleAndDecrement,
} from "./lib/airtable.js";

const app = express();
app.use(morgan("combined"));

app.get("/", (_req, res) => res.type("text/plain").send("Consignment bot OK"));
app.get("/health", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

/**
 * Payload from Airtable:
 * {
 *   order: {
 *     airtableRecordId, orderId, sku, size,
 *     targetBuyingPrice, maximumBuyingPrice,
 *     clientCountry, clientVatRate
 *   },
 *   sellers: [{
 *     sellerId, sellerName, inventoryRecordId,
 *     productName, sellingPriceSuggested,
 *     vatType, sellerCountry, quantity
 *   }, ...]
 * }
 */
app.post("/offers", async (req, res) => {
  try {
    const p = req.body || {};
    const orderRecId     = p?.order?.airtableRecordId;
    const orderHumanId   = p?.order?.orderId;
    const sku            = p?.order?.sku;
    const size           = p?.order?.size;
    const target         = p?.order?.targetBuyingPrice;
    const max            = p?.order?.maximumBuyingPrice;
    const clientCountry  = p?.order?.clientCountry;
    const clientVatRate  = p?.order?.clientVatRate;
    const sellers        = Array.isArray(p?.sellers) ? p.sellers : [];

    if (!orderRecId || !sku || !size || sellers.length === 0) {
      return res.status(400).json({ error: "Missing order basics or sellers" });
    }

    const results = [];
    for (const s of sellers) {
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
        target,
        max,
        vatType: s.vatType,
        sellerCountry: s.sellerCountry,
        clientCountry,
        clientVatRate,
        quantity: s.quantity ?? 1,
      });

      // log message so we can disable later
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

/** Close all buttons for an order (e.g., order moved to “Processed External”). */
app.post("/disable-offers", async (req, res) => {
  try {
    const { orderRecId, reason } = req.body || {};
    if (!orderRecId) return res.status(400).json({ error: "Missing orderRecId" });

    const msgs = await listOfferMessagesForOrder(orderRecId);
    await Promise.allSettled(
      msgs.map(m =>
        disableMessageButtonsGateway(
          m.channelId,
          m.messageId,
          `✅ ${reason || "Closed"}. Offers disabled.`
        )
      )
    );
    res.json({ ok: true, disabled: msgs.length });
  } catch (e) {
    console.error("disable-offers error:", e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("HTTP listening on :" + PORT));

/** Button interactions */
await initDiscord();
await onButtonInteraction(async ({ action, orderRecId, sellerId, inventoryRecordId, offerPrice }) => {
  try {
    if (action === "confirm") {
      // 1) Create Sales row + decrement Inventory.Quantity by 1
      await createSaleAndDecrement({ inventoryId: inventoryRecordId, orderRecId, finalPrice: offerPrice });

      // 2) Disable ALL messages belonging to this order
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
      // Optional: disable all, or only the one message. We disable all for clarity.
      const msgs = await listOfferMessagesForOrder(orderRecId);
      await Promise.allSettled(
        msgs.map(m =>
          disableMessageButtonsGateway(
            m.channelId,
            m.messageId,
            `❌ ${sellerId} denied / not available.`
          )
        )
      );
    }
  } catch (err) {
    console.error("Interaction handling error:", err);
  }
});
