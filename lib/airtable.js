// lib/airtable.js
import fetch from "node-fetch";

const {
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,

  // ---- Table names
  AIRTABLE_TABLE_ORDERS        = "Unfulfilled Orders Log",
  AIRTABLE_TABLE_INVENTORY     = "Inventory",
  AIRTABLE_TABLE_OFFER_MSGS    = "Offer Messages",

  // ---- Order table fields
  FIELD_ORDER_STATUS                   = "Fulfillment Status",
  FIELD_ORDER_STATUS_MATCHED_VALUE     = "Matched",
  FIELD_ORDER_STATUS_EXTERNAL_VALUE    = "Processed External",

  // ---- Inventory table fields
  FIELD_INV_SOLD         = "Sold?",
  FIELD_INV_FINAL_PRICE  = "Selling Price (Final)",
  AIRTABLE_INV_LINKED_ORDER = "Linked Order",            // linked to Orders table (or text in your base)

  // ---- Offer Messages table fields
  FIELD_OFFERS_ORDER_ID   = "Order Record ID",        // in your base this looks like TEXT
  FIELD_OFFERS_SELLER_ID  = "Seller ID",
  FIELD_OFFERS_INV_ID     = "Inventory Record ID",
  FIELD_OFFERS_CHANNEL_ID = "Channel ID",
  FIELD_OFFERS_MESSAGE_ID = "Message ID",
  FIELD_OFFERS_OFFER_PRICE= "Offer Price",
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

/* ------------------------ Offer Messages ------------------------ */

export async function logOfferMessage({ orderRecId, sellerId, inventoryRecordId, channelId, messageId, offerPrice }) {
  try {
    await airtableRequest("POST", encodeURIComponent(AIRTABLE_TABLE_OFFER_MSGS), {
      fields: {
        // Your "Order Record ID" field is TEXT right now, so write plain string:
        [FIELD_OFFERS_ORDER_ID]: orderRecId,
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
  // Filtering against a TEXT field:
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

/* ------------------------ Orders & Inventory ------------------------ */

export async function isOrderAlreadyMatched(orderRecId) {
  const rec = await airtableRequest("GET", `${encodeURIComponent(AIRTABLE_TABLE_ORDERS)}/${orderRecId}`);
  const statusRaw = rec.fields?.[FIELD_ORDER_STATUS];
  const statusName = (statusRaw && typeof statusRaw === "object" && statusRaw.name)
    ? statusRaw.name
    : (typeof statusRaw === "string" ? statusRaw : "");

  const s = String(statusName).toLowerCase();
  return s === String(FIELD_ORDER_STATUS_MATCHED_VALUE).toLowerCase()
      || s === String(FIELD_ORDER_STATUS_EXTERNAL_VALUE).toLowerCase();
}

export async function setInventorySold(inventoryRecordId, finalPrice) {
  await airtableRequest("PATCH", `${encodeURIComponent(AIRTABLE_TABLE_INVENTORY)}/${inventoryRecordId}`, {
    fields: {
      [FIELD_INV_SOLD]: true,
      [FIELD_INV_FINAL_PRICE]: (typeof finalPrice === "number") ? finalPrice : null,
    }
  });
}

/**
 * Link the inventory unit to an order.
 * Tries linked-record shape first, and if Airtable says 422 INVALID_RECORD_ID,
 * retries by writing the order id as a PLAIN STRING (for bases where the field is text).
 */
export async function linkInventoryToOrder(inventoryRecordId, orderRecId) {
  const tablePath = `${encodeURIComponent(AIRTABLE_TABLE_INVENTORY)}/${inventoryRecordId}`;

  // Attempt 1: linked-record shape
  try {
    await airtableRequest("PATCH", tablePath, {
      fields: { [AIRTABLE_INV_LINKED_ORDER]: [{ id: orderRecId }] }
    });
    return;
  } catch (e) {
    // Only fall back on the specific INVALID_RECORD_ID case
    if (!/INVALID_RECORD_ID/i.test(e.message)) throw e;
  }

  // Attempt 2: write as plain string
  await airtableRequest("PATCH", tablePath, {
    fields: { [AIRTABLE_INV_LINKED_ORDER]: orderRecId }
  });
}

export async function setOrderMatched(orderRecId) {
  await airtableRequest("PATCH", `${encodeURIComponent(AIRTABLE_TABLE_ORDERS)}/${orderRecId}`, {
    fields: { [FIELD_ORDER_STATUS]: { name: FIELD_ORDER_STATUS_MATCHED_VALUE } }
  });
}
