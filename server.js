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
  // optional: log rows per message; safe to keep wrapped in try/catch
  logOfferMessage,
  listOfferMessagesForOrder,
  // creates a Sales row and decrements Inventory.{Quantity} by 1
  createSaleAndDecrement,
} from "./lib/airtable.js";

const app = express();
app.use(morgan("combined"));

app.get("/", (_req, res) => res.type("text/plain").send("Consignment bot OK"));
app.get("/health", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

const fmt2 = v => (typeof v === "number" && isFinite(v) ? v.toFixed(2) : null);

app.post("/offers", async (req, res) => {
  try {
    const p = req.body || {};
    const orderRecId   = p?.order?.airtableRecordId;
    const orderHumanId = p?.order?.orderId || null;
    const sku          = p?.order?.sku || null;
    const size         = p?.order?.size || null;
    const sellers      = Array.isArray(p?.sellers) ? p.sellers : [];

    if (!orderRecId || sellers.length === 0) {
      return res.status(400).json({ error: "Missing order or sellers in payload" });
    }

    const results = [];
    for (const s of sellers) {
      // normalizedSuggested / normalizedMax expected from Airtable
      const suggested    = s.normalizedSuggested ?? s.sellingPriceSuggested ?? null;
      const adjustedMax  =
        s.normalizedMax ??
        s.maxBuyNormalized ??
        s.adjustedMax ??
        p?.order?.maxBuyNormalized ??  // accept from order if you send it
        null;

      // DEBUG: see exactly what we got per seller
      console.log("[fanout]", {
        seller: s.sellerName || s.sellerId,
        suggested,
        adjustedMax,
        vatType: s.vatType,
        sellerCountry: s.sellerCountry,
        qty: s.quantity
      });

      const { channelId, messageId, offerPrice } = await sendOfferMessageGateway({
        orderRecId,
        orderHumanId,
        sellerId: s.sellerId,
        sellerName: s.sellerName,
        inventoryRecordId: s.inventoryRecordId,
        productName: s.productName || null,
        sku,
        size,
        quantity: s.quantity ?? 1,

        // prices
        suggested,
        adjustedMax,

        // VAT meta for labels
        vatType: s.vatType || null,
        sellerCountry: s.sellerCountry || "",
        sellerVatRatePct: s.sellerVatRatePct ?? 21,

        // buyer (us) is NL — used only for label tag
        clientCountry: "Netherlands",
      });

      // optional best-effort log
      try {
        await logOfferMessage({
          orderRecId,
          sellerId: s.sellerId,
          inventoryRecordId: s.inventoryRecordId,
          channelId,
          messageId,
          offerPrice,
        });
      } catch (_) {}

      console.log(
        `[discord] posted to ${s.sellerName || s.sellerId} – suggested=${fmt2(suggested)} max=${fmt2(adjustedMax)}`
      );
      results.push({ sellerId: s.sellerId, messageId });
    }

    res.json({ ok: true, sentCount: results.length, sent: results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * External close hook (e.g., order moved to “Processed External” in Airtable)
 * Body: { orderRecId: "recXXXX", reason?: "string" }
 */
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
          `✅ ${reason || "Order closed"}. Offers disabled.`
        )
      )
    );
    res.json({ ok: true, disabled: msgs.length });
  } catch (e) {
    console.error("disable-offers error:", e);
    res.status(500).json({ error: e.message });
  }
});

/** Discord button interactions */
await initDiscord();
await onButtonInteraction(async ({ action, orderRecId, sellerId, inventoryRecordId, offerPrice }) => {
  try {
    if (action === "confirm") {
      // 1) Create a Sales row + decrement Inventory.Quantity by 1
      await createSaleAndDecrement({
        inventoryId: inventoryRecordId,
        orderRecId,
        finalPrice: offerPrice,
      });

      // 2) Disable ALL messages for this order
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
      // (You can choose to disable only this one; here we disable all for clarity)
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
  } catch (e) {
    console.error("Interaction handling error:", e);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("HTTP listening on :" + PORT));
