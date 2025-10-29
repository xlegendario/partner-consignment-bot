// lib/airtable.js
import fetch from "node-fetch";

const {
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,

  /* ---------- Table names (override via env if needed) ---------- */
  AIRTABLE_TABLE_ORDERS      = "Unfulfilled Orders Log",
  AIRTABLE_TABLE_INVENTORY   = "Inventory",
  AIRTABLE_TABLE_SALES       = "Sales",
  AIRTABLE_TABLE_OFFER_MSGS  = "Offer Messages",

  /* ---------- Orders table fields ---------- */
  FIELD_ORDER_STATUS                 = "Fulfillment Status",
  FIELD_ORDER_STATUS_MATCHED_VALUE   = "Matched",
  FIELD_ORDER_STATUS_EXTERNAL_VALUE  = "Processed External",

  /* ---------- Inventory table fields ---------- */
  FIELD_INV_QUANTITY       = "Quantity",
  FIELD_INV_SOLD           = "Sold?",                              // (kept for compatibility)
  FIELD_INV_FINAL_PRICE    = "Selling Price (Final)",              // if you still store it
  FIELD_INV_LINKED_ORDER   = "Linked Order",                       // linked to Orders (optional)
  FIELD_INV_PRODUCT_NAME   = "Master Product Name",
  FIELD_INV_SIZE           = "Size EU",
  FIELD_INV_BRAND          = "Brand",
  FIELD_INV_VAT_TYPE       = "VAT Type (Margin / VAT0 / VAT21)",
  FIELD_INV_SELLER_LINK    = "Linked Seller",                      // linked record to seller
  FIELD_INV_SKU_MASTER     = "SKU Master",                         // linked record to SKU table
  FIELD_INV_SELLER_COUNTRY = "Seller Country",                     // lookup/text
  FIELD_INV_SELLER_VATRATE = "Seller VAT Rate",                    // % (optional, for display)

  /* ---------- Sales table fields ---------- */
  FIELD_SALES_PRODUCT_NAME = "Product Name",
  FIELD_SALES_SKU_LINK     = "SKU",                                // linked to SKU Master
  FIELD_SALES_SIZE         = "Size",
  FIELD_SALES_BRAND        = "Brand",
  FIELD_SALES_VAT_TYPE     = "VAT Type",                           // single select
  FIELD_SALES_FINAL_PRICE  = "Final Selling Price",                // currency
  FIELD_SALES_SELLER_LINK  = "Seller ID",                          // linked to Seller Database
  FIELD_SALES_ORDER_LINK   = "Order Number",                       // linked to Orders

  /* ---------- Offer Messages table fields ---------- */
  FIELD_OFFERS_ORDER_ID    = "Order Record ID",                    // text or linked – we'll write text
  FIELD_OFFERS_SELLER_ID   = "Seller ID",
  FIELD_OFFERS_INV_ID      = "Inventory Record ID",
  FIELD_OFFERS_CHANNEL_ID  = "Channel ID",
  FIELD_OFFERS_MESSAGE_ID  = "Message ID",
  FIELD_OFFERS_OFFER_PRICE = "Offer Price",
} = process.env;

const AT_API = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}`;
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const isNL = (s) => String(s || "").toLowerCase().includes("nether");

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

/* ------------------ Offer Messages logging (optional) ------------------ */
export async function logOfferMessage({ orderRecId, sellerId, inventoryRecordId, channelId, messageId, offerPrice }) {
  try {
    await airtableRequest("POST", encodeURIComponent(AIRTABLE_TABLE_OFFER_MSGS), {
      fields: {
        [FIELD_OFFERS_ORDER_ID]:  orderRecId,            // store order rec id as text for simple filtering
        [FIELD_OFFERS_SELLER_ID]: sellerId ?? null,
        [FIELD_OFFERS_INV_ID]:    inventoryRecordId ?? null,
        [FIELD_OFFERS_CHANNEL_ID]: channelId ?? null,
        [FIELD_OFFERS_MESSAGE_ID]: messageId ?? null,
        [FIELD_OFFERS_OFFER_PRICE]: (typeof offerPrice === "number") ? round2(offerPrice) : null,
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

/* ------------------------- SALES creation flow ------------------------- */
/**
 * Creates a row in Sales using data from the Inventory record,
 * then decrements Inventory.Quantity by 1.
 *
 * Expects:
 *  - inventoryId: record id in Inventory
 *  - orderRecId : linked order record id
 *  - finalPrice : number (already the agreed price)
 */
export async function createSaleAndDecrement({ inventoryId, orderRecId, finalPrice }) {
  // 1) Read the Inventory record to collect all fields we need
  const inv = await airtableRequest(
    "GET",
    `${encodeURIComponent(AIRTABLE_TABLE_INVENTORY)}/${inventoryId}`
  );

  const f = inv.fields || {};

  // Linked IDs for SKU and Seller
  const skuLink = Array.isArray(f[FIELD_INV_SKU_MASTER]) && f[FIELD_INV_SKU_MASTER][0]?.id
    ? [{ id: f[FIELD_INV_SKU_MASTER][0].id }]
    : [];
  const sellerLink = Array.isArray(f[FIELD_INV_SELLER_LINK]) && f[FIELD_INV_SELLER_LINK][0]?.id
    ? [{ id: f[FIELD_INV_SELLER_LINK][0].id }]
    : [];

  // Basic text fields
  const productName = String(f[FIELD_INV_PRODUCT_NAME] ?? "").trim();
  const size        = String(f[FIELD_INV_SIZE] ?? "").trim();
  const brand       = String(f[FIELD_INV_BRAND] ?? "").trim();

  // VAT type & seller country for override logic
  const invVatType     = String(f[FIELD_INV_VAT_TYPE] ?? "").trim();
  const sellerCountry  = String(
    Array.isArray(f[FIELD_INV_SELLER_COUNTRY]) ? f[FIELD_INV_SELLER_COUNTRY][0] : f[FIELD_INV_SELLER_COUNTRY]
  ).trim();

  // 2) Decide the VAT Type we store on **Sales**
  // If inventory is VAT0 but seller is NL (selling domestically to your NL company),
  // record VAT21 on the Sale; else keep inventory VAT type.
  let saleVatType = invVatType || "";
  if (invVatType.toUpperCase().includes("VAT0") && isNL(sellerCountry)) {
    saleVatType = "VAT21";
  }

  // 3) Create Sales row
  const saleFields = {
    [FIELD_SALES_PRODUCT_NAME]: productName || null,
    [FIELD_SALES_SIZE]: size || null,
    [FIELD_SALES_BRAND]: brand || null,
    [FIELD_SALES_FINAL_PRICE]: (typeof finalPrice === "number") ? round2(finalPrice) : null,
    [FIELD_SALES_SELLER_LINK]: sellerLink.length ? sellerLink : null,
    [FIELD_SALES_ORDER_LINK]: [{ id: orderRecId }],
    [FIELD_SALES_SKU_LINK]: skuLink.length ? skuLink : null,
    [FIELD_SALES_VAT_TYPE]: saleVatType ? { name: saleVatType } : null,
  };

  // Debug print (helpful if a field name mismatch occurs)
  console.log("Creating Sale:", JSON.stringify(saleFields, null, 2));

  await airtableRequest("POST", encodeURIComponent(AIRTABLE_TABLE_SALES), { fields: saleFields });

  // 4) Decrement Inventory.Quantity by 1 (min 0)
  const qty = typeof f[FIELD_INV_QUANTITY] === "number" ? f[FIELD_INV_QUANTITY] : 0;
  const newQty = Math.max(0, qty - 1);

  await airtableRequest(
    "PATCH",
    `${encodeURIComponent(AIRTABLE_TABLE_INVENTORY)}/${inventoryId}`,
    { fields: { [FIELD_INV_QUANTITY]: newQty } }
  );
}

/* ---------------------------- (Optional) ---------------------------- */
/** If you still use these anywhere, keep them here; otherwise you can remove. */
export async function isOrderAlreadyMatched(orderRecId) {
  const rec = await airtableRequest("GET", `${encodeURIComponent(AIRTABLE_TABLE_ORDERS)}/${orderRecId}`);
  const raw = rec.fields?.[FIELD_ORDER_STATUS];
  const statusName = (raw && typeof raw === "object" && raw.name) ? raw.name
                    : (typeof raw === "string" ? raw : "");
  const s = statusName.toLowerCase();
  return s === String(FIELD_ORDER_STATUS_MATCHED_VALUE).toLowerCase()
      || s === String(FIELD_ORDER_STATUS_EXTERNAL_VALUE).toLowerCase();
}

export async function setOrderMatched(orderRecId) {
  await airtableRequest("PATCH", `${encodeURIComponent(AIRTABLE_TABLE_ORDERS)}/${orderRecId}`, {
    fields: { [FIELD_ORDER_STATUS]: { name: FIELD_ORDER_STATUS_MATCHED_VALUE } },
  });
}
