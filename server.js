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
  hasSaleForOrder,            // ← add
  setOrderMatchedStatus,      // ← add
} from "./lib/airtable.js";

const processingOrders = new Set();

const app = express();
app.use(morgan("combined"));

app.get("/", (_req, res) => res.type("text/plain").send("Consignment bot OK"));
app.get("/health", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** Receive one order + fan-out to sellers */
app.post("/offers", async (req, res) => {
  try {
    const p = req.body || {};
    const orderRecId   = p?.order?.airtableRecordId;
    const orderHumanId = p?.order?.orderId;
    const sku          = p?.order?.sku;
    const size         = p?.order?.size;
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
        productName: s.productName || null,
        sku,
        size,
        suggested: s.normalizedSuggested ?? s.sellingPriceSuggested ?? null,
        adjustedMax: undefined,
        vatType: s.vatType,
        sellerCountry: s.sellerCountry,
        clientCountry: "Netherlands",
        quantity: s.quantity ?? 1,
        showMax: false,
      });

      // 👇 Log every message so /disable-offers can close them all later
      try {
        await logOfferMessage({
          orderRecId,
          sellerId: s.sellerId,
          inventoryRecordId: s.inventoryRecordId,
          channelId,
          messageId,
          offerPrice,
        });
      } catch (e) {
        console.warn("logOfferMessage warn:", e.message);
      }

      results.push({ sellerId: s.sellerId, messageId });
    }

    res.json({ ok: true, sentCount: results.length, sent: results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});


/** External closer (e.g., order moved to Processed External) */
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
    // 🔒 Only react to this service's actions. Ignore external (_ext) buttons.
    if (!["confirm", "deny"].includes(action)) {
      return; // ignore confirm_ext / deny_ext etc.
    }

    if (action === "deny") {
      await disableMessageButtonsGateway(channelId, messageId, `❌ ${sellerId} denied / not available.`);
      return;
    }

    // action === "confirm"
    // 1) In-memory mutex (protects against near-simultaneous clicks on this instance)
    if (processingOrders.has(orderRecId)) {
      await disableMessageButtonsGateway(channelId, messageId, "⏳ Already being processed by another click.");
      return;
    }
    processingOrders.add(orderRecId);

    // 2) Idempotency guard in Airtable (protects against retries / other instances)
    if (await hasSaleForOrder(orderRecId)) {
      // Already sold/matched; close all buttons
      const msgs = await listOfferMessagesForOrder(orderRecId);
      await Promise.allSettled(
        msgs.map(m => disableMessageButtonsGateway(m.channelId, m.messageId, "✅ Already matched. Offers closed."))
      );
      return;
    }

    // 3) Create sale + decrement quantity
    await createSaleAndDecrement({ inventoryId: inventoryRecordId, orderRecId, finalPrice: offerPrice });

    // 4) Mark the order as matched (so any later paths see it)
    await setOrderMatchedStatus(orderRecId, "Matched");

    // 5) Disable clicked message immediately
    await disableMessageButtonsGateway(channelId, messageId, `✅ Matched by ${sellerId}.`);

    // 6) Disable all other messages for this order
    const msgs = await listOfferMessagesForOrder(orderRecId);
    await Promise.allSettled(
      msgs
        .filter(m => !(m.channelId === channelId && m.messageId === messageId))
        .map(m => disableMessageButtonsGateway(m.channelId, m.messageId, "✅ Matched by another seller. Offers closed."))
    );
  } catch (e) {
    console.error("Interaction handling error:", e);
  } finally {
    processingOrders.delete(orderRecId);
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("HTTP listening on :" + PORT));
