import fetch from "node-fetch";

const API = "https://api.airtable.com/v0";

const {
  AIRTABLE_TOKEN,
  AIRTABLE_BASE_ID,

  AIRTABLE_TABLE_INVENTORY,
  AIRTABLE_TABLE_ORDERS,
  AIRTABLE_TABLE_OFFERS,

  AIRTABLE_INV_SOLD,
  AIRTABLE_INV_SALE_DATE,
  AIRTABLE_INV_PRICE_FINAL,

  AIRTABLE_ORD_STATUS,
  AIRTABLE_ORD_STATUS_MATCHED_VALUE,

  AIRTABLE_OFFERS_ORDER_ID,
  AIRTABLE_OFFERS_SELLER_ID,
  AIRTABLE_OFFERS_INV_ID,
  AIRTABLE_OFFERS_CHANNEL_ID,
  AIRTABLE_OFFERS_MESSAGE_ID,
  AIRTABLE_OFFERS_OFFER_PRICE
} = process.env;

function authHeaders() {
  return { Authorization: `Bearer ${AIRTABLE_TOKEN}`, "Content-Type": "application/json" };
}

async function patchRecord(table, recordId, fields) {
  const res = await fetch(`${API}/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}/${recordId}`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ fields })
  });
  if (!res.ok) throw new Error(`[Airtable] PATCH ${table}/${recordId} → ${res.status} ${await res.text()}`);
  return res.json();
}

async function getRecord(table, recordId) {
  const res = await fetch(`${API}/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}/${recordId}`, {
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` }
  });
  if (!res.ok) throw new Error(`[Airtable] GET ${table}/${recordId} → ${res.status} ${await res.text()}`);
  return res.json();
}

export async function setInventorySold(invRecordId, finalPrice) {
  const fields = {
    [AIRTABLE_INV_SOLD]: true,
    [AIRTABLE_INV_SALE_DATE]: new Date().toISOString()
  };
  if (finalPrice != null && !Number.isNaN(Number(finalPrice))) {
    fields[AIRTABLE_INV_PRICE_FINAL] = Number(finalPrice);
  }
  return patchRecord(AIRTABLE_TABLE_INVENTORY, invRecordId, fields);
}

export async function setOrderMatched(orderRecId) {
  return patchRecord(AIRTABLE_TABLE_ORDERS, orderRecId, {
    [AIRTABLE_ORD_STATUS]: AIRTABLE_ORD_STATUS_MATCHED_VALUE
  });
}

export async function isOrderAlreadyMatched(orderRecId) {
  const r = await getRecord(AIRTABLE_TABLE_ORDERS, orderRecId);
  const v = r?.fields?.[AIRTABLE_ORD_STATUS];
  if (!v) return false;
  if (typeof v === "object" && v.name) return v.name === AIRTABLE_ORD_STATUS_MATCHED_VALUE; // single select
  if (typeof v === "string") return v === AIRTABLE_ORD_STATUS_MATCHED_VALUE; // text
  return false;
}

export async function logOfferMessage({ orderRecId, sellerId, inventoryRecordId, channelId, messageId, offerPrice }) {
  const url = `${API}/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_OFFERS)}`;
  const fields = {
    [AIRTABLE_OFFERS_ORDER_ID]: orderRecId,
    [AIRTABLE_OFFERS_SELLER_ID]: sellerId,
    [AIRTABLE_OFFERS_INV_ID]: inventoryRecordId,
    [AIRTABLE_OFFERS_CHANNEL_ID]: channelId,
    [AIRTABLE_OFFERS_MESSAGE_ID]: messageId,
    [AIRTABLE_OFFERS_OFFER_PRICE]: offerPrice
  };
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ records: [{ fields }] })
  });
  if (!res.ok) throw new Error(`[Airtable] create Offer Message → ${res.status} ${await res.text()}`);
  return res.json();
}

export async function listOfferMessagesForOrder(orderRecId) {
  const filter = `AND({${AIRTABLE_OFFERS_ORDER_ID}} = '${orderRecId}')`;
  const url = `${API}/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_OFFERS)}?filterByFormula=${encodeURIComponent(filter)}&pageSize=100`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
  if (!res.ok) throw new Error(`[Airtable] list Offer Messages → ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data.records || []).map(r => ({
    channelId: r.fields?.[AIRTABLE_OFFERS_CHANNEL_ID],
    messageId: r.fields?.[AIRTABLE_OFFERS_MESSAGE_ID]
  }));
}
