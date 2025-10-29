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
  const {
    AIRTABLE_TABLE_INVENTORY = "Inventory",
    AIRTABLE_TABLE_SALES     = "Sales",

    // Inventory fields
    FIELD_INV_QTY               = "Quantity",
    FIELD_INV_PRODUCT_NAME      = "Master Product Name",
    FIELD_INV_SIZE              = "Size EU",
    FIELD_INV_BRAND             = "Brand",
    FIELD_INV_VAT_TYPE          = "VAT Type (Margin / VAT0 / VAT21)",
    FIELD_INV_LINK_SKU_MASTER   = "SKU Master",
    FIELD_INV_LINKED_SELLER     = "Linked Seller",

    // Sales fields (rename here if your base differs)
    FIELD_SALE_PRODUCT_NAME     = "Product Name",
    FIELD_SALE_SKU_LINK         = "SKU",                // linked to SKU Master
    FIELD_SALE_SIZE             = "Size",
    FIELD_SALE_BRAND            = "Brand",
    FIELD_SALE_FINAL_PRICE      = "Final Selling Price",
    FIELD_SALE_VAT_TYPE         = "VAT Type",           // single select
    FIELD_SALE_SELLER_LINK      = "Seller ID",          // linked to Seller Database
    FIELD_SALE_ORDER_LINK       = "Order Number",       // linked to Unfulfilled Orders Log
  } = process.env;

  const toText = (val) => {
    if (!val) return null;
    if (Array.isArray(val)) {
      const parts = val.map(x =>
        typeof x === "string" ? x :
        (x && typeof x.name === "string" ? x.name : null)
      ).filter(Boolean);
      return parts.join(", ") || null;
    }
    if (typeof val === "object" && val.name) return val.name;
    if (typeof val === "string") return val.trim();
    if (typeof val === "number") return String(val);
    return null;
  };

  const toNumber = (val) => {
    if (typeof val === "number") return val;
    if (typeof val === "string") {
      const n = parseFloat(val.replace(/[^\d.,-]/g, "").replace(",", "."));
      return Number.isNaN(n) ? null : n;
    }
    return null;
  };

  const getFirstLinkedId = (val) => {
    if (!Array.isArray(val) || !val.length) return null;
    const first = val[0];
    if (typeof first === "string") return first;
    if (first && typeof first.id === "string") return first.id;
    return null;
  };

  // 1) Read Inventory
  const inv = await airtableRequest(
    "GET",
    `${encodeURIComponent(AIRTABLE_TABLE_INVENTORY)}/${inventoryId}`
  );
  const f = inv.fields || {};

  const productName  = toText(f[FIELD_INV_PRODUCT_NAME]) || "";
  const size         = toText(f[FIELD_INV_SIZE]) || "";
  const brand        = toText(f[FIELD_INV_BRAND]) || "";
  const vatTypeName  = toText(f[FIELD_INV_VAT_TYPE]) || "";

  const skuLinkId     = getFirstLinkedId(f[FIELD_INV_LINK_SKU_MASTER]); // rec id
  const sellerLinkId  = getFirstLinkedId(f[FIELD_INV_LINKED_SELLER]);   // rec id

  // 2) Create Sales row
  const saleFields = {
    [FIELD_SALE_PRODUCT_NAME]: productName,
    [FIELD_SALE_SIZE]: size,
    [FIELD_SALE_BRAND]: brand,
    [FIELD_SALE_FINAL_PRICE]: (typeof finalPrice === "number") ? finalPrice : null,
    [FIELD_SALE_VAT_TYPE]: vatTypeName || undefined,             // single select as string
    [FIELD_SALE_SKU_LINK]: skuLinkId ? [skuLinkId] : undefined,  // linked record id array
    [FIELD_SALE_SELLER_LINK]: sellerLinkId ? [sellerLinkId] : undefined,
    [FIELD_SALE_ORDER_LINK]: orderRecId ? [orderRecId] : undefined,
  };

  console.log("Creating Sale:", saleFields);

  await airtableRequest(
    "POST",
    encodeURIComponent(AIRTABLE_TABLE_SALES),
    { fields: saleFields }
  );

  // 3) Decrement Inventory.Quantity by 1
  const currentQty = toNumber(f[FIELD_INV_QTY]) ?? 0;
  const newQty = Math.max(0, currentQty - 1);

  await airtableRequest(
    "PATCH",
    `${encodeURIComponent(AIRTABLE_TABLE_INVENTORY)}/${inventoryId}`,
    { fields: { [FIELD_INV_QTY]: newQty } }
  );

  console.log(`✅ Sale created + Quantity decremented → newQty: ${newQty}`);
}

