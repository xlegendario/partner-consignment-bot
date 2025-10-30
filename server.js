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
app.post("/offers", async (req, res) => {
  try {
    const p = req.body || {};
    const orderRecId     = p?.order?.airtableRecordId;
    const orderHumanId   = p?.order?.orderId;
    const sku            = p?.order?.sku;
    const size           = p?.order?.size;
    const clientCountry  = p?.order?.clientCountry;
    const clientVatRate  = p?.order?.clientVatRate;
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
        suggested: s.sellingPriceSuggested,
        normalizedSuggested: s.normalizedSuggested,   // if present from Airtable script
        adjustedMax: s.adjustedMax,                   // if present from Airtable script
        vatType: s.vatType,
        sellerCountry: s.sellerCountry,
        clientCountry,
        clientVatRate,
        quantity: s.quantity ?? 1,
      });

      // ✅ LOG THE MESSAGE so we can find & disable it later
      await logOfferMessage({
        orderRecId,
        channelId,
        messageId,
      });

      results.push({ sellerId: s.sellerId, messageId });
    }

    res.json({ ok: true, sentCount: results.length, sent: results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

/** Close offers externally (e.g., order moved to Processed External) */
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

/** Button interactions */
await initDiscord();
await onButtonInteraction(async ({ action, orderRecId, sellerId, inventoryRecordId, offerPrice, channelId, messageId }) => {
  try {
    if (action === "confirm") {
      // 1) Create Sales row + decrement Quantity
      await createSaleAndDecrement({ inventoryId: inventoryRecordId, orderRecId, finalPrice: offerPrice });

      // 2) Disable the message that was clicked immediately
      await disableMessageButtonsGateway(channelId, messageId, `✅ Matched by ${sellerId}.`);

      // 3) Disable all other messages for this order
      const msgs = await listOfferMessagesForOrder(orderRecId);
      await Promise.allSettled(
        msgs
          .filter(m => !(m.channelId === channelId && m.messageId === messageId))
          .map(m =>
            disableMessageButtonsGateway(
              m.channelId,
              m.messageId,
              `✅ Matched by ${sellerId}. Offers closed.`
            )
          )
      );
    } else if (action === "deny") {
      // Disable only the pressed message on deny
      await disableMessageButtonsGateway(
        channelId,
        messageId,
        `❌ ${sellerId} denied / not available.`
      );
    }
  } catch (e) {
    console.error("Interaction handling error:", e);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("HTTP listening on :" + PORT));
