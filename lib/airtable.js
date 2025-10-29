// lib/airtable.js
import fetch from "node-fetch";

const {
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,

  // ---- Table names
  AIRTABLE_TABLE_ORDERS        = "Unfulfilled Orders Log",
  AIRTABLE_TABLE_INVENTORY     = "Inventory",
  AIRTABLE_TABLE_OFFER_MSGS    = "Offer Messages",
  AIRTABLE_TABLE_SALES         = "Sales",

  // ---- Inventory fields
  FIELD_INV_QTY                = "Quantity",
  FIELD_INV_SELLER_ID          = "Seller ID",
  FIELD_INV_LINKED_SELLER      = "Linked Seller",        // linked-record to Sellers
  FIELD_INV_VAT_TYPE           = "VAT Type (Margin / VAT0 / VAT21)",
  FIELD_INV_PRODUCT_NAME       = "Master Product Name",
  FIELD_INV_SKU_MASTER         = "SKU Master",           // linked-record to SKU Master
  FIELD_INV_BRAND              = "Brand",
  FIELD_INV_SIZE               = "Size EU",

  // ---- Sales fields
  FIELD_SALE_PRODUCT_NAME      = "Product Name",
  FIELD_SALE_SKU_LINK          = "SKU",                  // linked-record to SKU Master
  FIELD_SALE_SIZE              = "Size",
  FIELD_SALE_BRAND             = "Brand",
  FIELD_SALE_FINAL_PRICE       = "Final Selling Price",
  FIELD_SALE_VAT_TYPE          = "VAT Type",
  FIELD_SALE_SELLER_LINK       = "Seller ID",            // linked-record (same as Linked Seller type)
  FIELD_SALE_ORDER_LINK        = "Order Number",         // linked-record to Orders

  // ---- Offer Messages table fields (all plain text/currency recommended)
  FIELD_OFFERS_ORDER_ID        = "Order Record ID",
  FIELD_OFFERS_SELLER_ID       = "Seller ID",
  FIELD_OFFERS_INV_ID          = "Inventory Record ID",
  FIELD_OFFERS_CHANNEL_ID      = "Channel ID",
  FIELD_OFFERS_MESSAGE_ID      = "Message ID",
  FIELD_OFFERS_OFFER_PRICE     = "Offer Price",
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

/* ---------- Offer Messages (log for later disable) ---------- */
export async function logOfferMessage({ orderRecId, sellerId, inventoryRecordId, channelId, messageId, offerPrice }) {
  try {
    await airtableRequest("POST", encodeURIComponent(AIRTABLE_TABLE_OFFER_MSGS), {
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
    `${encodeURIComponent(AIRTABLE_TABLE_OFFER_MSGS)}?filterByFormula=${encodeURIComponent(formula)}`
  );
  return (data.records || [])
    .map(r => ({
      channelId: r.fields?.[FIELD_OFFERS_CHANNEL_ID],
      messageId: r.fields?.[FIELD_OFFERS_MESSAGE_ID],
    }))
    .filter(x => x.channelId && x.messageId);
}

/* ---------- Sales creation + decrement inventory ---------- */
export async function createSaleAndDecrement({ inventoryId, orderRecId, finalPrice }) {
  // 1) Read inventory record
  const inv = await airtableRequest("GET", `${encodeURIComponent(AIRTABLE_TABLE_INVENTORY)}/${inventoryId}`);
  const f = inv.fields || {};

  // Prepare Sales fields; copy linked-record arrays as-is when available
  const saleFields = {
    [FIELD_SALE_PRODUCT_NAME]: f[FIELD_INV_PRODUCT_NAME] ?? null,
    [FIELD_SALE_SIZE]:         f[FIELD_INV_SIZE] ?? null,
    [FIELD_SALE_BRAND]:        f[FIELD_INV_BRAND] ?? null,
    [FIELD_SALE_FINAL_PRICE]:  (typeof finalPrice === "number") ? finalPrice : null,
    [FIELD_SALE_VAT_TYPE]:     f[FIELD_INV_VAT_TYPE] ?? null,
    [FIELD_SALE_ORDER_LINK]:   [{ id: orderRecId }],
  };

  // SKU link (array of linked IDs)
  if (Array.isArray(f[FIELD_INV_SKU_MASTER]) && f[FIELD_INV_SKU_MASTER].length) {
    saleFields[FIELD_SALE_SKU_LINK] = f[FIELD_INV_SKU_MASTER].map(x => ({ id: x.id || x }));
  }

  // Seller link (copy the linked-record array if present)
  if (Array.isArray(f[FIELD_INV_LINKED_SELLER]) && f[FIELD_INV_LINKED_SELLER].length) {
    saleFields[FIELD_SALE_SELLER_LINK] = f[FIELD_INV_LINKED_SELLER].map(x => ({ id: x.id || x }));
  }

  // 2) Create Sales row
  await airtableRequest("POST", encodeURIComponent(AIRTABLE_TABLE_SALES), { fields: saleFields });

  // 3) Decrement Quantity by 1
  const curQty = Number(f[FIELD_INV_QTY]) || 0;
  const newQty = Math.max(0, curQty - 1);
  await airtableRequest("PATCH", `${encodeURIComponent(AIRTABLE_TABLE_INVENTORY)}/${inventoryId}`, {
    fields: { [FIELD_INV_QTY]: newQty }
  });

  return { newQty };
}
