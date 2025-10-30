// lib/airtable.js
import fetch from "node-fetch";

const {
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,

  // ---- Tables
  AIRTABLE_TABLE_ORDERS            = "Unfulfilled Orders Log",
  AIRTABLE_TABLE_INVENTORY         = "Inventory",
  AIRTABLE_TABLE_SALES             = "Sales",
  AIRTABLE_TABLE_OFFER_MSGS        = "Offer Messages",   // for logging/disable-all

  // ---- Inventory fields
  FIELD_INV_PRODUCT_NAME           = "Master Product Name",
  FIELD_INV_SIZE                   = "Size EU",
  FIELD_INV_BRAND                  = "Brand",
  FIELD_INV_VAT_TYPE               = "VAT Type (Margin / VAT0 / VAT21)",
  FIELD_INV_SELLER_COUNTRY         = "Seller Country",
  FIELD_INV_QTY                    = "Quantity",
  FIELD_INV_LINKED_SELLER          = "Linked Seller",    // linked to Seller Database
  FIELD_INV_SKU_MASTER             = "SKU Master",       // linked to SKU Master

  // ---- Sales fields
  FIELD_SALE_PRODUCT_NAME          = "Product Name",
  FIELD_SALE_SKU                   = "SKU",              // linked to SKU Master
  FIELD_SALE_SIZE                  = "Size",
  FIELD_SALE_BRAND                 = "Brand",
  FIELD_SALE_VAT_TYPE              = "VAT Type",         // single select
  FIELD_SALE_FINAL_PRICE           = "Final Selling Price",
  FIELD_SALE_SELLER_ID             = "Seller ID",        // linked to Seller Database
  FIELD_SALE_ORDER_NUMBER          = "Order Number",     // linked to Orders

  // ---- Offer Messages fields (for logging & disable-all)
  FIELD_OFFERS_ORDER_ID            = "Order Record ID",  // can be linked or text; we filter by string
  FIELD_OFFERS_SELLER_ID           = "Seller ID",
  FIELD_OFFERS_INV_ID              = "Inventory Record ID",
  FIELD_OFFERS_CHANNEL_ID          = "Channel ID",
  FIELD_OFFERS_MESSAGE_ID          = "Message ID",
  FIELD_OFFERS_OFFER_PRICE         = "Offer Price",
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

/* ------------------------ helpers ------------------------ */

const isNL = s => String(s || "").toLowerCase().includes("nether");
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

function getText(fieldValue) {
  if (fieldValue == null) return null;
  if (typeof fieldValue === "string") return fieldValue;
  if (typeof fieldValue === "number") return String(fieldValue);
  if (Array.isArray(fieldValue)) {
    if (fieldValue.length && fieldValue[0]?.name) return fieldValue[0].name;
    if (fieldValue.length && fieldValue[0]?.id)   return fieldValue[0].id;
  }
  if (typeof fieldValue === "object" && fieldValue.name) return fieldValue.name;
  return null;
}

function linkIdsFrom(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map(v => (v && typeof v === "object" && v.id ? { id: v.id } : null))
      .filter(Boolean);
  }
  if (typeof value === "string" && value.startsWith("rec")) return [{ id: value }];
  return [];
}

/* ------------------------ Sales creation + decrement ------------------------ */

/**
 * Create a Sales row and decrement the Inventory Quantity by 1.
 * @param {Object} p
 * @param {string} p.inventoryId
 * @param {string} p.orderRecId
 * @param {number} p.finalPrice
 */
export async function createSaleAndDecrement({ inventoryId, orderRecId, finalPrice }) {
  // 1) Read the inventory record
  const invRec = await airtableRequest(
    "GET",
    `${encodeURIComponent(AIRTABLE_TABLE_INVENTORY)}/${inventoryId}`
  );

  const f = invRec.fields || {};

  const productName   = getText(f[FIELD_INV_PRODUCT_NAME]) || "";
  const size          = getText(f[FIELD_INV_SIZE]) || "";
  const brand         = getText(f[FIELD_INV_BRAND]) || "";
  const vatTypeName   = getText(f[FIELD_INV_VAT_TYPE]) || "";     // "VAT0" | "VAT21" | "Margin"
  const sellerCountry = getText(f[FIELD_INV_SELLER_COUNTRY]) || "";
  const qtyNow        = Number(f[FIELD_INV_QTY] || 0);

  // Linked IDs required for Sales
  const sellerLinks = linkIdsFrom(f[FIELD_INV_LINKED_SELLER]);
  const skuLinks    = linkIdsFrom(f[FIELD_INV_SKU_MASTER]);
  const orderLinks  = [{ id: orderRecId }];

  if (sellerLinks.length === 0) {
    throw new Error(`Inventory ${inventoryId}: Linked Seller field empty or not a linked record.`);
  }
  if (skuLinks.length === 0) {
    throw new Error(`Inventory ${inventoryId}: SKU Master field empty or not a linked record.`);
  }

  // VAT override: seller is NL + VAT0 → store VAT21 in Sales
  let saleVatType = vatTypeName;
  if (String(vatTypeName).toUpperCase().includes("VAT0") && isNL(sellerCountry)) {
    saleVatType = "VAT21";
  }

  const saleFields = {
    [FIELD_SALE_PRODUCT_NAME]: productName,
    [FIELD_SALE_SIZE]:         size,
    [FIELD_SALE_BRAND]:        brand,
    [FIELD_SALE_FINAL_PRICE]:  round2(finalPrice),
    [FIELD_SALE_VAT_TYPE]:     saleVatType ? { name: saleVatType } : undefined,
    [FIELD_SALE_ORDER_NUMBER]: orderLinks,
    [FIELD_SALE_SELLER_ID]:    sellerLinks,  // ✅ linked IDs
    [FIELD_SALE_SKU]:          skuLinks,     // ✅ linked IDs
  };

  console.log("Creating Sale:", JSON.stringify(saleFields, null, 2));

  // 3) Create Sales row
  await airtableRequest(
    "POST",
    encodeURIComponent(AIRTABLE_TABLE_SALES),
    { fields: saleFields }
  );

  // 4) Decrement quantity by 1 (not below 0)
  const newQty = Math.max(0, (Number.isFinite(qtyNow) ? qtyNow : 0) - 1);
  await airtableRequest(
    "PATCH",
    `${encodeURIComponent(AIRTABLE_TABLE_INVENTORY)}/${inventoryId}`,
    { fields: { [FIELD_INV_QTY]: newQty } }
  );
}

/* ------------------------ Offer Messages log (optional) ------------------------ */

/** Log a Discord message so we can disable it later. Safe to no-op if table not present. */
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

/** Return {channelId, messageId} for every logged message of an order. */
export async function listOfferMessagesForOrder(orderRecId) {
  try {
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
  } catch (e) {
    console.warn("listOfferMessagesForOrder warn:", e.message);
    return [];
  }
}
