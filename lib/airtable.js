// lib/airtable.js
import fetch from "node-fetch";

const {
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,
  AIRTABLE_TABLE_INVENTORY = "Inventory",
  AIRTABLE_TABLE_ORDERS = "Unfulfilled Orders Log",
  // Set this to your exact linked field name in Inventory that points to Orders:
  AIRTABLE_LINKED_ORDER_FIELD = "Linked Order",
} = process.env;

const AT_BASE = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}`;

async function airtableRequest(method, path, body) {
  const res = await fetch(`${AT_BASE}/${path}`, {
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

/** Mark inventory record as sold, set final price & sale date */
export async function setInventorySold(inventoryRecordId, finalPrice) {
  const priceNum = Number(finalPrice);
  const fields = {
    "Sold?": true,
    "Sale Date": new Date().toISOString(),
  };
  if (!Number.isNaN(priceNum)) {
    fields["Selling Price (Final)"] = priceNum;
  }
  return airtableRequest(
    "PATCH",
    `${encodeURIComponent(AIRTABLE_TABLE_INVENTORY)}/${encodeURIComponent(inventoryRecordId)}`,
    { fields }
  );
}

/** Link the inventory record to the order via linked-record field (MUST be an array) */
export async function linkInventoryToOrder(inventoryRecordId, orderRecId) {
  // IMPORTANT: linked record fields must be an array of { id: recId }
  const fields = {
    [AIRTABLE_LINKED_ORDER_FIELD]: [{ id: orderRecId }],
  };
  return airtableRequest(
    "PATCH",
    `${encodeURIComponent(AIRTABLE_TABLE_INVENTORY)}/${encodeURIComponent(inventoryRecordId)}`,
    { fields }
  );
}

/** Update order “Fulfillment Status” to Matched */
export async function setOrderMatched(orderRecId) {
  return airtableRequest(
    "PATCH",
    `${encodeURIComponent(AIRTABLE_TABLE_ORDERS)}/${encodeURIComponent(orderRecId)}`,
    { fields: { "Fulfillment Status": { name: "Matched" } } }
  );
}

/** Check if order is already marked Matched (idempotency) */
export async function isOrderAlreadyMatched(orderRecId) {
  const rec = await airtableRequest(
    "GET",
    `${encodeURIComponent(AIRTABLE_TABLE_ORDERS)}/${encodeURIComponent(orderRecId)}`
  );
  const status = rec?.fields?.["Fulfillment Status"];
  const name = typeof status === "object" && status?.name ? status.name : null;
  return String(name || "").toLowerCase() === "matched";
}

/** Log sent Discord message (Offer Messages table) — optional */
export async function logOfferMessage({ orderRecId, sellerId, inventoryRecordId, channelId, messageId, offerPrice }) {
  const table = process.env.AIRTABLE_TABLE_OFFER_MESSAGES || "Offer Messages";
  try {
    await airtableRequest(
      "POST",
      encodeURIComponent(table),
      {
        fields: {
          "Order": [{ id: orderRecId }],
          "Seller ID": sellerId || "",
          "Inventory Record": [{ id: inventoryRecordId }],
          "Discord Channel ID": channelId,
          "Discord Message ID": messageId,
          "Offer Price": typeof offerPrice === "number" ? offerPrice : null,
        }
      }
    );
  } catch (e) {
    // Non-fatal: keep the flow if this auxiliary log fails
    console.warn("logOfferMessage warn:", e.message);
  }
}

/** Get all logged messages for an order, for mass-disabling on match */
export async function listOfferMessagesForOrder(orderRecId) {
  const table = process.env.AIRTABLE_TABLE_OFFER_MESSAGES || "Offer Messages";
  const filter = encodeURIComponent(`SEARCH("${orderRecId}", ARRAYJOIN({Order}))`);
  const res = await airtableRequest(
    "GET",
    `${encodeURIComponent(table)}?filterByFormula=${filter}`
  );
  // Normalize output the way server expects it
  return (res?.records || []).map(r => ({
    id: r.id,
    channelId: r.fields?.["Discord Channel ID"],
    messageId: r.fields?.["Discord Message ID"],
  })).filter(m => m.channelId && m.messageId);
}
