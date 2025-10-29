// lib/airtable.js
import fetch from "node-fetch";

const {
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,

  // Tables
  AIRTABLE_TABLE_ORDERS     = "Unfulfilled Orders Log",
  AIRTABLE_TABLE_INVENTORY  = "Inventory",
  AIRTABLE_TABLE_OFFERS     = "Offer Messages",
  AIRTABLE_TABLE_SALES      = "Sales",

  // Inventory fields
  FIELD_INV_QTY            = "Quantity",
  FIELD_INV_PRODUCT_NAME   = "Master Product Name",
  FIELD_INV_VAT_TYPE       = "VAT Type (Margin / VAT0 / VAT21)",
  FIELD_INV_SIZE           = "Size EU",
  FIELD_INV_BRAND          = "Brand",
  FIELD_INV_SELLER_LINK    = "Linked Seller",     // linked-record (preferred)
  FIELD_INV_SELLER_ID_TEXT = "Seller ID",         // fallback text
  FIELD_INV_SKU_MASTER     = "SKU Master",        // linked-record to SKU Master

  // Sales fields
  FIELD_SALE_PRODUCT_NAME  = "Product Name",
  FIELD_SALE_SKU_LINK      = "SKU",               // linked-record to SKU Master
  FIELD_SALE_SIZE          = "Size",
  FIELD_SALE_BRAND         = "Brand",
  FIELD_SALE_FINAL_PRICE   = "Final Selling Price",
  FIELD_SALE_VAT_TYPE      = "VAT Type",
  FIELD_SALE_SELLER_LINK   = "Seller ID",         // linked-record (same as inventory’s Linked Seller)
  FIELD_SALE_ORDER_LINK    = "Order Number",      // linked-record to Orders

  // Offer Messages fields (optional but useful)
  FIELD_OFFERS_ORDER_ID    = "Order Record ID",   // text or linked — we’ll write text
  FIELD_OFFERS_SELLER_ID   = "Seller ID",
  FIELD_OFFERS_INV_ID      = "Inventory Record ID",
  FIELD_OFFERS_CHANNEL_ID  = "Channel ID",
  FIELD_OFFERS_MESSAGE_ID  = "Message ID",
  FIELD_OFFERS_OFFER_PRICE = "Offer Price",
} = process.env;

const AT_API = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}`;

async function airtableRequest(method, path, body) {
  const res = await fetch(`${AT_API}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`[Airtable] ${method} ${path} → ${res.status} ${txt}`);
  }
  return res.json();
}

/* ---------- Offer Messages logging ---------- */
export async function logOfferMessage({ orderRecId, sellerId, inventoryRecordId, channelId, messageId, offerPrice }) {
  try {
    await airtableRequest("POST", encodeURIComponent(AIRTABLE_TABLE_OFFERS), {
      fields: {
        [FIELD_OFFERS_ORDER_ID]:   orderRecId,
        [FIELD_OFFERS_SELLER_ID]:  sellerId ?? null,
        [FIELD_OFFERS_INV_ID]:     inventoryRecordId ?? null,
        [FIELD_OFFERS_CHANNEL_ID]: channelId ?? null,
        [FIELD_OFFERS_MESSAGE_ID]: messageId ?? null,
        [FIELD_OFFERS_OFFER_PRICE]: (typeof offerPrice === "number") ? offerPrice : null,
      }
    });
  } catch (e) {
    console.warn("logOfferMessage warn:", e.message);
  }
}

export async function listOfferMessagesForOrder(orderRecId) {
  const formula = `{${FIELD_OFFERS_ORDER_ID}}='${orderRecId}'`;
  const data = await airtableRequest(
    "GET",
    `${encodeURIComponent(AIRTABLE_TABLE_OFFERS)}?filterByFormula=${encodeURIComponent(formula)}`
  );
  return (data.records || [])
    .map(r => ({
      channelId: r.fields?.[FIELD_OFFERS_CHANNEL_ID],
      messageId: r.fields?.[FIELD_OFFERS_MESSAGE_ID],
    }))
    .filter(x => x.channelId && x.messageId);
}

/* ---------- Sales creation + qty decrement ---------- */
export async function createSaleAndDecrement({ inventoryId, orderRecId, finalPrice }) {
  // 1) Load inventory record (for Sales fields & current qty)
  const invRec = await airtableRequest("GET", `${encodeURIComponent(AIRTABLE_TABLE_INVENTORY)}/${inventoryId}`);

  const f = invRec.fields || {};
  const qty = Number(f[FIELD_INV_QTY] ?? 0);
  const newQty = Math.max(0, (Number.isFinite(qty) ? qty : 0) - 1);

  // Extract values for Sales
  const productName = f[FIELD_INV_PRODUCT_NAME] || null;
  const vatType     = f[FIELD_INV_VAT_TYPE] || null;
  const sizeValue   = f[FIELD_INV_SIZE] || null;
  const brandValue  = f[FIELD_INV_BRAND] || null;

  // Linked IDs
  const skuLinkId   = Array.isArray(f[FIELD_INV_SKU_MASTER]) && f[FIELD_INV_SKU_MASTER][0]?.id
                    ? f[FIELD_INV_SKU_MASTER][0].id : null;
  const sellerLinkId = Array.isArray(f[FIELD_INV_SELLER_LINK]) && f[FIELD_INV_SELLER_LINK][0]?.id
                     ? f[FIELD_INV_SELLER_LINK][0].id : null;

  // 2) Create Sales row
  await airtableRequest("POST", encodeURIComponent(AIRTABLE_TABLE_SALES), {
    fields: {
      [FIELD_SALE_PRODUCT_NAME]: productName,
      [FIELD_SALE_SKU_LINK]:     skuLinkId ? [{ id: skuLinkId }] : undefined,
      [FIELD_SALE_SIZE]:         sizeValue ?? null,
      [FIELD_SALE_BRAND]:        brandValue ?? null,
      [FIELD_SALE_FINAL_PRICE]:  (typeof finalPrice === "number") ? finalPrice : null,
      [FIELD_SALE_VAT_TYPE]:     vatType ?? null,
      [FIELD_SALE_SELLER_LINK]:  sellerLinkId ? [{ id: sellerLinkId }] : undefined,
      [FIELD_SALE_ORDER_LINK]:   [{ id: orderRecId }],
    }
  });

  // 3) Decrement quantity by 1
  await airtableRequest("PATCH", `${encodeURIComponent(AIRTABLE_TABLE_INVENTORY)}/${inventoryId}`, {
    fields: { [FIELD_INV_QTY]: newQty }
  });
}
