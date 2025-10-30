// lib/airtable.js
import fetch from "node-fetch";

const {
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,

  // --- TABLES
  AIRTABLE_TABLE_ORDERS     = "Unfulfilled Orders Log",
  AIRTABLE_TABLE_INVENTORY  = "Inventory",
  AIRTABLE_TABLE_SALES      = "Sales",
  AIRTABLE_TABLE_OFFER_MSGS = "Offer Messages",

  // --- INVENTORY FIELDS
  FIELD_INV_QTY               = "Quantity",
  FIELD_INV_PRODUCT_NAME      = "Master Product Name",
  FIELD_INV_SIZE              = "Size EU",
  FIELD_INV_BRAND             = "Brand",
  FIELD_INV_VAT_TYPE          = "VAT Type (Margin / VAT0 / VAT21)",
  FIELD_INV_LINK_SKU_MASTER   = "SKU Master",     // linked to SKU Master
  FIELD_INV_LINKED_SELLER     = "Linked Seller",  // linked to Sellers Database

  // --- SALES FIELDS (as in your screenshots)
  FIELD_SALE_PRODUCT_NAME     = "Product Name",
  FIELD_SALE_SKU_LINK         = "SKU",                 // linked -> expects ["rec..."]
  FIELD_SALE_SIZE             = "Size",
  FIELD_SALE_BRAND            = "Brand",
  FIELD_SALE_FINAL_PRICE      = "Final Selling Price", // number/currency
  FIELD_SALE_VAT_TYPE         = "VAT Type",            // single select -> expects plain string value
  FIELD_SALE_SELLER_LINK      = "Seller ID",           // linked -> expects ["rec..."]
  FIELD_SALE_ORDER_LINK       = "Order Number",        // linked -> expects ["rec..."]

  // --- OFFER MSG FIELDS (optional table)
  FIELD_OFFERS_ORDER_ID       = "Order Record ID",     // text in your setup
  FIELD_OFFERS_CHANNEL_ID     = "Channel ID",
  FIELD_OFFERS_MESSAGE_ID     = "Message ID",
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

/* -------------------- small helpers (match old working shapes) -------------------- */

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

// Return first linked rec id if the cell is ["rec..."] or [{id:"rec..."}]
const getFirstLinkedId = (val) => {
  if (!Array.isArray(val) || !val.length) return null;
  const first = val[0];
  if (typeof first === "string") return first;
  if (first && typeof first.id === "string") return first.id;
  return null;
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/* -------------------- Offer Messages (optional) -------------------- */

export async function logOfferMessage({ orderRecId, channelId, messageId }) {
  try {
    await airtableRequest("POST", encodeURIComponent(AIRTABLE_TABLE_OFFER_MSGS), {
      fields: {
        [FIELD_OFFERS_ORDER_ID]: orderRecId, // plain text in your base
        [FIELD_OFFERS_CHANNEL_ID]: channelId,
        [FIELD_OFFERS_MESSAGE_ID]: messageId,
      }
    });
  } catch (e) {
    console.warn("logOfferMessage warn:", e.message);
  }
}

export async function listOfferMessagesForOrder(orderRecId) {
  // Plain-text filter (your base uses text for Order Record ID)
  const data = await airtableRequest(
    "GET",
    `${encodeURIComponent(AIRTABLE_TABLE_OFFER_MSGS)}?filterByFormula=${encodeURIComponent(
      `{${FIELD_OFFERS_ORDER_ID}}='${orderRecId}'`
    )}`
  );
  return (data.records || []).map(r => ({
    channelId: r.fields?.[FIELD_OFFERS_CHANNEL_ID],
    messageId: r.fields?.[FIELD_OFFERS_MESSAGE_ID],
  })).filter(x => x.channelId && x.messageId);
}

/* -------------------- Create Sales row + decrement Inventory -------------------- */

export async function createSaleAndDecrement({ inventoryId, orderRecId, finalPrice }) {
  // 1) Read Inventory
  const inv = await airtableRequest(
    "GET",
    `${encodeURIComponent(AIRTABLE_TABLE_INVENTORY)}/${inventoryId}`
  );
  const f = inv.fields || {};

  const productName  = toText(f[FIELD_INV_PRODUCT_NAME]) || "";
  const size         = toText(f[FIELD_INV_SIZE]) || "";
  const brand        = toText(f[FIELD_INV_BRAND]) || "";
  const vatTypeName  = toText(f[FIELD_INV_VAT_TYPE]) || ""; // "Margin" | "VAT0" | "VAT21"

  // Linked record IDs
  const skuLinkId     = getFirstLinkedId(f[FIELD_INV_LINK_SKU_MASTER]);
  const sellerLinkId  = getFirstLinkedId(f[FIELD_INV_LINKED_SELLER]);

  if (!sellerLinkId) {
    throw new Error(`Inventory ${inventoryId}: Linked Seller field empty or not a linked record.`);
  }
  if (!skuLinkId) {
    throw new Error(`Inventory ${inventoryId}: SKU Master field empty or not a linked record.`);
  }

  // ⚙️ Compute VAT type for Sales record only (do NOT touch inventory)
  const vatTypeOut = (String(vatTypeName).toUpperCase() === "VAT0") ? "VAT21" : (vatTypeName || "Margin");

  // 2) Create Sales row
  const saleFields = {
    [FIELD_SALE_PRODUCT_NAME]: productName,
    [FIELD_SALE_SIZE]:         size,
    [FIELD_SALE_BRAND]:        brand,
    [FIELD_SALE_FINAL_PRICE]:  round2(finalPrice),
    [FIELD_SALE_VAT_TYPE]:     vatTypeOut,              // plain string for single select
    [FIELD_SALE_SKU_LINK]:     [skuLinkId],
    [FIELD_SALE_SELLER_LINK]:  [sellerLinkId],
    [FIELD_SALE_ORDER_LINK]:   orderRecId ? [orderRecId] : undefined,
  };

  console.log("Creating Sale:", saleFields);

  await airtableRequest(
    "POST",
    encodeURIComponent(AIRTABLE_TABLE_SALES),
    { fields: saleFields }
  );

  // 3) Only decrement Inventory.Quantity by 1 (don’t change VAT type!)
  const currentQty = toNumber(f[FIELD_INV_QTY]) ?? 0;
  const newQty = Math.max(0, currentQty - 1);

  await airtableRequest(
    "PATCH",
    `${encodeURIComponent(AIRTABLE_TABLE_INVENTORY)}/${inventoryId}`,
    { fields: { [FIELD_INV_QTY]: newQty } }
  );

  console.log(`✅ Sale created + Quantity decremented → newQty: ${newQty}`);
}
