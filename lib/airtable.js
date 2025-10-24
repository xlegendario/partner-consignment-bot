// lib/airtable.js
// Uses Airtable REST API (no SDK). Node 18+/Render has global fetch.

const {
  AIRTABLE_TOKEN,
  AIRTABLE_BASE_ID,

  // Tables
  AIRTABLE_TABLE_INVENTORY = "Inventory",
  AIRTABLE_TABLE_ORDERS = "Unfulfilled Orders Log",
  AIRTABLE_TABLE_OFFERS = "Offer Messages",

  // Inventory fields
  AIRTABLE_INV_SOLD = "Sold?",
  AIRTABLE_INV_SALE_DATE = "Sale Date",
  AIRTABLE_INV_PRICE_FINAL = "Selling Price (Final)",
  AIRTABLE_INV_LINKED_ORDER, // e.g. "Linked Order"  (REQUIRED for linking)

  // Orders fields
  AIRTABLE_ORD_STATUS = "Fulfillment Status",
  AIRTABLE_ORD_STATUS_MATCHED_VALUE = "Matched", // the single select option name

  // Offer Messages fields (log of sent Discord messages)
  AIRTABLE_OFFERS_ORDER_ID = "Order Record ID",
  AIRTABLE_OFFERS_SELLER_ID = "Seller ID",
  AIRTABLE_OFFERS_INV_ID = "Inventory Record ID",
  AIRTABLE_OFFERS_CHANNEL_ID = "Channel ID",
  AIRTABLE_OFFERS_MESSAGE_ID = "Message ID",
  AIRTABLE_OFFERS_OFFER_PRICE = "Offer Price",
} = process.env;

if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID) {
  console.warn("⚠️ Set AIRTABLE_TOKEN and AIRTABLE_BASE_ID in environment.");
}

const API_BASE = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}`;

async function airtableRequest(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API_BASE}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
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

/** ---- PUBLIC API used by server.js ---- */

/** Mark an Inventory record as sold at final price and set sale date (UTC now) */
export async function setInventorySold(inventoryRecordId, finalPrice) {
  if (!inventoryRecordId) throw new Error("setInventorySold: missing inventoryRecordId");
  const fields = {
    [AIRTABLE_INV_SOLD]: true,
    [AIRTABLE_INV_SALE_DATE]: new Date().toISOString(),
  };
  if (typeof finalPrice === "number" && !Number.isNaN(finalPrice)) {
    fields[AIRTABLE_INV_PRICE_FINAL] = finalPrice;
  }
  return airtableRequest(
    `${encodeURIComponent(AIRTABLE_TABLE_INVENTORY)}/${inventoryRecordId}`,
    { method: "PATCH", body: { fields } }
  );
}

/** Link an Inventory record to an Order (Link to another record field) */
export async function linkInventoryToOrder(inventoryRecordId, orderRecordId) {
  if (!AIRTABLE_INV_LINKED_ORDER) {
    throw new Error("Set AIRTABLE_INV_LINKED_ORDER (e.g., 'Linked Order').");
  }
  if (!inventoryRecordId) throw new Error("linkInventoryToOrder: missing inventoryRecordId");
  const fields = {
    [AIRTABLE_INV_LINKED_ORDER]: orderRecordId ? [{ id: orderRecordId }] : [],
  };
  return airtableRequest(
    `${encodeURIComponent(AIRTABLE_TABLE_INVENTORY)}/${inventoryRecordId}`,
    { method: "PATCH", body: { fields } }
  );
}

/** Set an Order’s Fulfillment Status to “Matched” (single select option name) */
export async function setOrderMatched(orderRecordId) {
  if (!orderRecordId) throw new Error("setOrderMatched: missing orderRecordId");
  const fields = {
    [AIRTABLE_ORD_STATUS]: { name: AIRTABLE_ORD_STATUS_MATCHED_VALUE },
  };
  return airtableRequest(
    `${encodeURIComponent(AIRTABLE_TABLE_ORDERS)}/${orderRecordId}`,
    { method: "PATCH", body: { fields } }
  );
}

/** Check if an Order is already matched (Fulfillment Status == “Matched”) */
export async function isOrderAlreadyMatched(orderRecordId) {
  if (!orderRecordId) return false;
  const rec = await airtableRequest(
    `${encodeURIComponent(AIRTABLE_TABLE_ORDERS)}/${orderRecordId}`
  );
  const status = rec?.fields?.[AIRTABLE_ORD_STATUS];
  // status can be a string, or a {name} object depending on field type
  const name =
    (status && typeof status === "object" && "name" in status && status.name) ||
    (typeof status === "string" ? status : null);
  return String(name || "").trim() === String(AIRTABLE_ORD_STATUS_MATCHED_VALUE).trim();
}

/** Log a sent Discord message so we can disable all later */
export async function logOfferMessage({
  orderRecId,
  sellerId,
  inventoryRecordId,
  channelId,
  messageId,
  offerPrice,
}) {
  const fields = {
    [AIRTABLE_OFFERS_ORDER_ID]: orderRecId || "",
    [AIRTABLE_OFFERS_SELLER_ID]: sellerId || "",
    [AIRTABLE_OFFERS_INV_ID]: inventoryRecordId || "",
    [AIRTABLE_OFFERS_CHANNEL_ID]: channelId || "",
    [AIRTABLE_OFFERS_MESSAGE_ID]: messageId || "",
  };
  if (typeof offerPrice === "number" && !Number.isNaN(offerPrice)) {
    fields[AIRTABLE_OFFERS_OFFER_PRICE] = offerPrice;
  }
  return airtableRequest(
    `${encodeURIComponent(AIRTABLE_TABLE_OFFERS)}`,
    { method: "POST", body: { records: [{ fields }] } }
  );
}

/** Get all offer messages for an order so we can disable them */
export async function listOfferMessagesForOrder(orderRecId) {
  const formula = `{${
    AIRTABLE_OFFERS_ORDER_ID
  }}='${orderRecId.replace(/'/g, "\\'")}'`;
  const path = `${encodeURIComponent(AIRTABLE_TABLE_OFFERS)}?filterByFormula=${encodeURIComponent(
    formula
  )}&pageSize=100`;
  const json = await airtableRequest(path);
  return (json?.records || []).map((r) => ({
    id: r.id,
    channelId: r.fields?.[AIRTABLE_OFFERS_CHANNEL_ID],
    messageId: r.fields?.[AIRTABLE_OFFERS_MESSAGE_ID],
    offerPrice: r.fields?.[AIRTABLE_OFFERS_OFFER_PRICE],
    sellerId: r.fields?.[AIRTABLE_OFFERS_SELLER_ID],
    inventoryRecordId: r.fields?.[AIRTABLE_OFFERS_INV_ID],
  }));
}
