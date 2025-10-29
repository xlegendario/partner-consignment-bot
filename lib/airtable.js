// lib/airtable.js
import fetch from "node-fetch";

const {
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,

  // Table names (env allows you to rename without code changes)
  AIRTABLE_TABLE_ORDERS = "Unfulfilled Orders Log",
  AIRTABLE_TABLE_INVENTORY = "Inventory",
  AIRTABLE_TABLE_OFFER_MSGS = "Offer Messages",

  // Field names (adjust if your base differs)
  FIELD_ORDER_STATUS = "Fulfillment Status",
  FIELD_ORDER_STATUS_MATCHED_VALUE = "Matched",
  FIELD_ORDER_STATUS_EXTERNAL_VALUE = "Processed External",

  FIELD_INV_SOLD = "Sold?",
  FIELD_INV_FINAL_PRICE = "Selling Price",
  FIELD_INV_LINKED_ORDER = "Linked Order", // Linked-record field to Orders
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

/** Log a Discord message so we can disable it later */
export async function logOfferMessage({ orderRecId, sellerId, inventoryRecordId, channelId, messageId, offerPrice }) {
  try {
    await airtableRequest("POST", encodeURIComponent(AIRTABLE_TABLE_OFFER_MSGS), {
      fields: {
        "Order": [{ id: orderRecId }],                 // linked to Orders table
        "Seller ID": sellerId,
        "Inventory Record": inventoryRecordId,
        "Channel ID": channelId,
        "Message ID": messageId,
        "Offer Price": typeof offerPrice === "number" ? offerPrice : null,
      }
    });
  } catch (e) {
    // Don't crash the flow on logging errors; just warn
    console.warn("logOfferMessage warn:", e.message);
  }
}

/** Fetch all logged messages for an order */
export async function listOfferMessagesForOrder(orderRecId) {
  const data = await airtableRequest(
    "GET",
    `${encodeURIComponent(AIRTABLE_TABLE_OFFER_MSGS)}?filterByFormula=${encodeURIComponent(`{Order}='${orderRecId}'`)}`
  );
  return (data.records || []).map(r => ({
    channelId: r.fields["Channel ID"],
    messageId: r.fields["Message ID"],
  })).filter(x => x.channelId && x.messageId);
}

/** Has the order already been matched/processed externally? */
export async function isOrderAlreadyMatched(orderRecId) {
  const rec = await airtableRequest("GET", `${encodeURIComponent(AIRTABLE_TABLE_ORDERS)}/${orderRecId}`);
  const statusName =
    (rec.fields?.[FIELD_ORDER_STATUS] && rec.fields[FIELD_ORDER_STATUS].name)
    || (typeof rec.fields?.[FIELD_ORDER_STATUS] === "string" ? rec.fields[FIELD_ORDER_STATUS] : null);

  const matched = String(statusName || "").toLowerCase();
  return matched === String(FIELD_ORDER_STATUS_MATCHED_VALUE).toLowerCase()
      || matched === String(FIELD_ORDER_STATUS_EXTERNAL_VALUE).toLowerCase();
}

/** Mark inventory unit as sold and store final price */
export async function setInventorySold(inventoryRecordId, finalPrice) {
  await airtableRequest("PATCH", `${encodeURIComponent(AIRTABLE_TABLE_INVENTORY)}/${inventoryRecordId}`, {
    fields: {
      [FIELD_INV_SOLD]: true,
      [FIELD_INV_FINAL_PRICE]: (typeof finalPrice === "number") ? finalPrice : null,
    }
  });
}

/** Link the inventory unit to an order (linked-record field) */
export async function linkInventoryToOrder(inventoryRecordId, orderRecId) {
  await airtableRequest("PATCH", `${encodeURIComponent(AIRTABLE_TABLE_INVENTORY)}/${inventoryRecordId}`, {
    fields: {
      [FIELD_INV_LINKED_ORDER]: [{ id: orderRecId }]   // ✅ correct shape
    }
  });
}

/** Mark order as matched */
export async function setOrderMatched(orderRecId) {
  await airtableRequest("PATCH", `${encodeURIComponent(AIRTABLE_TABLE_ORDERS)}/${orderRecId}`, {
    fields: {
      [FIELD_ORDER_STATUS]: { name: FIELD_ORDER_STATUS_MATCHED_VALUE }
    }
  });
}
