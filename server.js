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

/** Fan-out from Airtable */
// ...imports/config unchanged...

app.post("/offers", async (req, res) => {
  try {
    const p = req.body || {};
    const orderRecId     = p?.order?.airtableRecordId;
    const orderHumanId   = p?.order?.orderId;
    const sku            = p?.order?.sku;
    const size           = p?.order?.size;
    const clientCountry  = p?.order?.clientCountry;
    const clientVatRate  = p?.order?.clientVatRate;        // ← add
    const sellers        = Array.isArray(p?.sellers) ? p.sellers : [];

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
        productName: s.productName || null,
        sku,
        size,
        // prices
        suggested: s.sellingPriceSuggested,
        normalizedSuggested: s.normalizedSuggested,   // ← add
        adjustedMax: s.normalizedSuggested,           // we use normalized vs max logic client-side
        // meta
        vatType: s.vatType,
        sellerCountry: s.sellerCountry,
        clientCountry,
        clientVatRate,                                // ← add
        quantity: s.quantity ?? 1,
      });

      // (optional logging table call here…)

      results.push({ sellerId: s.sellerId, messageId });
    }

    res.json({ ok: true, sentCount: results.length, sent: results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});


/** Close offers externally (order moved to Processed External) */
app.post("/disable-offers", async (req, res) => {
  try {
    const { orderRecId, reason } = req.body || {};
    if (!orderRecId) return res.status(400).json({ error: "Missing orderRecId" });

    const msgs = await listOfferMessagesForOrder(orderRecId);
    await Promise.allSettled(
      msgs.map(m => disableMessageButtonsGateway(m.channelId, m.messageId, `✅ ${reason || "Closed"}. Offers disabled.`))
    );
    res.json({ ok: true, disabled: msgs.length });
  } catch (e) {
    console.error("disable-offers error:", e);
    res.status(500).json({ error: e.message });
  }
});

/** Button interactions */
await initDiscord();
await onButtonInteraction(async ({ action, orderRecId, sellerId, inventoryRecordId, offerPrice }) => {
  try {
    if (action === "confirm") {
      // 1) Create Sales row + decrement Quantity
      await createSaleAndDecrement({ inventoryId: inventoryRecordId, orderRecId, finalPrice: offerPrice });

      // 2) Disable ALL messages belonging to this order
      const msgs = await listOfferMessagesForOrder(orderRecId);
      await Promise.allSettled(
        msgs.map(m => disableMessageButtonsGateway(m.channelId, m.messageId, `✅ Matched by ${sellerId}. Offers closed.`))
      );
    } else if (action === "deny") {
      // We only disable *that one* msg on deny — optional to disable all
      const msgs = await listOfferMessagesForOrder(orderRecId);
      await Promise.allSettled(
        msgs.map(m => disableMessageButtonsGateway(m.channelId, m.messageId, `❌ ${sellerId} denied / not available.`))
      );
    }
  } catch (e) {
    console.error("Interaction handling error:", e);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("HTTP listening on :" + PORT));
