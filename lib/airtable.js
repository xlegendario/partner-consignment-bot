// lib/airtable.js
import fetch from "node-fetch";

const {
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,

  AIRTABLE_TABLE_ORDERS,
  AIRTABLE_TABLE_INVENTORY,
  AIRTABLE_TABLE_SALES,
  AIRTABLE_TABLE_OFFER_MSGS,

  // Inventory fields
  FIELD_INV_QTY            = "Quantity",
  FIELD_INV_LINKED_SELLER  = "Linked Seller",
  FIELD_INV_VAT_TYPE       = "VAT Type (Margin / VAT0 / VAT21)",
  FIELD_INV_SIZE           = "Size EU",
  FIELD_INV_BRAND          = "Brand",
  FIELD_INV_PRODUCT_NAME   = "Master Product Name",
  FIELD_INV_SKU_MASTER     = "SKU Master",

  // Sales fields
  FIELD_SALE_PRODUCT_NAME  = "Product Name",
  FIELD_SALE_SKU_LINK      = "SKU",
  FIELD_SALE_SIZE          = "Size",
  FIELD_SALE_BRAND         = "Brand",
  FIELD_SALE_PRICE_FINAL   = "Final Selling Price",
  FIELD_SALE_VAT_TYPE      = "VAT Type",
  FIELD_SALE_SELLER_LINK   = "Seller ID",
  FIELD_SALE_ORDER_LINK    = "Order Number",

  // Offer Messages fields (plain text/number)
  FIELD_OM_ORDER_ID        = "Order Record ID",
  FIELD_OM_SELLER_ID       = "Seller ID",
  FIELD_OM_INV_ID          = "Inventory Record ID",
  FIELD_OM_CHANNEL_ID      = "Channel ID",
  FIELD_OM_MESSAGE_ID      = "Message ID",
  FIELD_OM_OFFER_PRICE     = "Offer Price",
} = process.env;

const AT = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}`;

async function at(method, path, body) {
  const res = await fetch(`${AT}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`[Airtable] ${method} ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

/* ---------- Offer Messages log ---------- */
export async function logOfferMessage({ orderRecId, sellerId, inventoryRecordId, channelId, messageId, offerPrice }) {
  try {
    await at("POST", encodeURIComponent(AIRTABLE_TABLE_OFFER_MSGS), {
      fields: {
        [FIELD_OM_ORDER_ID]: orderRecId,
        [FIELD_OM_SELLER_ID]: sellerId ?? null,
        [FIELD_OM_INV_ID]: inventoryRecordId ?? null,
        [FIELD_OM_CHANNEL_ID]: channelId ?? null,
        [FIELD_OM_MESSAGE_ID]: messageId ?? null,
        [FIELD_OM_OFFER_PRICE]: (typeof offerPrice === "number") ? offerPrice : null,
      }
    });
  } catch (e) {
    console.warn("logOfferMessage warn:", e.message);
  }
}

export async function listOfferMessagesForOrder(orderRecId) {
  const formula = `{${FIELD_OM_ORDER_ID}}='${orderRecId}'`;
  const data = await at("GET", `${encodeURIComponent(AIRTABLE_TABLE_OFFER_MSGS)}?filterByFormula=${encodeURIComponent(formula)}`);
  return (data.records || []).map(r => ({
    channelId: r.fields?.[FIELD_OM_CHANNEL_ID],
    messageId: r.fields?.[FIELD_OM_MESSAGE_ID],
  })).filter(x => x.channelId && x.messageId);
}

/* ---------- Inventory & Sales ---------- */
async function getInventoryMinimal(invId) {
  const rec = await at("GET", `${encodeURIComponent(AIRTABLE_TABLE_INVENTORY)}/${invId}`);
  const f = rec.fields || {};
  return {
    id: rec.id,
    qty: Number(f[FIELD_INV_QTY] ?? 0),
    productName: f[FIELD_INV_PRODUCT_NAME] || null,
    size: f[FIELD_INV_SIZE] || null,
    brand: f[FIELD_INV_BRAND] || null,
    vatType: f[FIELD_INV_VAT_TYPE] || null,
    skuMaster: Array.isArray(f[FIELD_INV_SKU_MASTER]) ? f[FIELD_INV_SKU_MASTER].map(x => x.id) : [],
    sellerLink: Array.isArray(f[FIELD_INV_LINKED_SELLER]) ? f[FIELD_INV_LINKED_SELLER].map(x => x.id) : [],
  };
}

export async function createSaleAndDecrement({ inventoryId, orderRecId, finalPrice }) {
  const inv = await getInventoryMinimal(inventoryId);

  // 1) Create sale record
  const sale = await at("POST", encodeURIComponent(AIRTABLE_TABLE_SALES), {
    fields: {
      [FIELD_SALE_PRODUCT_NAME]: inv.productName || null,
      [FIELD_SALE_SKU_LINK]: inv.skuMaster?.length ? inv.skuMaster : undefined,
      [FIELD_SALE_SIZE]: inv.size || null,
      [FIELD_SALE_BRAND]: inv.brand || null,
      [FIELD_SALE_PRICE_FINAL]: (typeof finalPrice === "number") ? finalPrice : null,
      [FIELD_SALE_VAT_TYPE]: inv.vatType || null,
      [FIELD_SALE_SELLER_LINK]: inv.sellerLink?.length ? inv.sellerLink : undefined,
      [FIELD_SALE_ORDER_LINK]: orderRecId ? [orderRecId] : undefined,
    }
  });

  // 2) Decrement quantity by 1 (not below zero)
  const newQty = Math.max(0, (inv.qty || 0) - 1);
  await at("PATCH", `${encodeURIComponent(AIRTABLE_TABLE_INVENTORY)}/${inventoryId}`, {
    fields: { [FIELD_INV_QTY]: newQty }
  });

  return sale;
}
