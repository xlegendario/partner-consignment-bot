// lib/airtable.js
import fetch from "node-fetch";

/* ============================== ENV ============================== */

const {
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,

  // --- TABLES (override in Render if your names differ)
  AIRTABLE_TABLE_ORDERS        = "Unfulfilled Orders Log",
  AIRTABLE_TABLE_INVENTORY     = "Inventory",
  AIRTABLE_TABLE_SALES         = "Sales",
  AIRTABLE_TABLE_OFFER_MSGS    = "Offer Messages",

  // --- INVENTORY FIELDS
  FIELD_INV_PRODUCT_NAME       = "Master Product Name", // text/lookup acceptable
  FIELD_INV_SIZE               = "Size EU",
  FIELD_INV_BRAND              = "Brand",
  FIELD_INV_VAT_TYPE           = "VAT Type (Margin / VAT0 / VAT21)",
  FIELD_INV_LINKED_SELLER      = "Linked Seller",       // linked to Sellers Database
  FIELD_INV_SKU_MASTER         = "SKU Master",          // linked to SKU Master
  FIELD_INV_QUANTITY           = "Quantity",            // number
  // Optional: if you also maintain a boolean
  FIELD_INV_SOLD               = "Sold?",               // optional

  // --- SALES FIELDS (targets we insert into)
  FIELD_SALE_PRODUCT_NAME      = "Product Name",        // text
  FIELD_SALE_SKU               = "SKU",                 // linked to SKU Master
  FIELD_SALE_SIZE              = "Size",                // text
  FIELD_SALE_BRAND             = "Brand",               // text
  FIELD_SALE_VAT_TYPE          = "VAT Type",            // single select
  FIELD_SALE_FINAL_PRICE       = "Final Selling Price", // currency/number
  FIELD_SALE_SELLER_ID         = "Seller ID",           // linked to Sellers Database
  FIELD_SALE_ORDER_NUMBER      = "Order Number",        // linked to Unfulfilled Orders Log

  // --- OFFER MESSAGES (for disabling buttons later)
  FIELD_OFFERS_ORDER_ID        = "Order Record ID",     // text OR linked; we support both
  FIELD_OFFERS_CHANNEL_ID      = "Channel ID",
  FIELD_OFFERS_MESSAGE_ID      = "Message ID",
} = process.env;

const AT_API = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}`;

/* ============================ HELPERS ============================ */

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

// Accept "rec...", ["rec..."], or [{id:"rec..."}] ➜ always [{id:"rec..."}]
function toLinks(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map(v => {
        if (typeof v === "string" && v.startsWith("rec")) return { id: v };
        if (v && typeof v === "object" && typeof v.id === "string") return { id: v.id };
        return null;
      })
      .filter(Boolean);
  }
  if (typeof value === "string" && value.startsWith("rec")) return [{ id: value }];
  return [];
}

const get = (obj, key) => (obj && Object.prototype.hasOwnProperty.call(obj, key)) ? obj[key] : undefined;
const getText = (fields, key) => {
  const v = get(fields, key);
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) {
    const parts = v.map(x => {
      if (typeof x === "string") return x;
      if (x && typeof x === "object" && typeof x.name === "string") return x.name;
      return null;
    }).filter(Boolean);
    return parts.length ? parts.join(", ") : null;
  }
  if (typeof v === "object" && v !== null) {
    if (typeof v.name === "string") return v.name;
  }
  return null;
};

const getSingleSelectName = (fields, key) => {
  const v = get(fields, key);
  if (!v) return null;
  if (typeof v === "object" && typeof v.name === "string") return v.name;
  if (typeof v === "string") return v; // if your select stores raw strings
  return null;
};

const getNumber = (fields, key) => {
  const v = get(fields, key);
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const parsed = parseFloat(v.replace(/[^\d.,-]/g, "").replace(",", "."));
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

const isNL = s => String(s || "").toLowerCase().includes("nether");
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

/* ====================== OFFER MESSAGES (Optional) ====================== */
/** Safe logger: if your Offer Messages table exists, this writes; otherwise it just warns. */
export async function logOfferMessage({ orderRecId, channelId, messageId }) {
  try {
    await airtableRequest("POST", encodeURIComponent(AIRTABLE_TABLE_OFFER_MSGS), {
      fields: {
        [FIELD_OFFERS_ORDER_ID]: orderRecId, // works for text field; if linked, Airtable will coerce by formula later
        [FIELD_OFFERS_CHANNEL_ID]: channelId,
        [FIELD_OFFERS_MESSAGE_ID]: messageId,
      }
    });
  } catch (e) {
    console.warn("logOfferMessage warn:", e.message);
  }
}

/** Return all {channelId, messageId} for a given Order record ID. */
export async function listOfferMessagesForOrder(orderRecId) {
  // Try equality first (works if FIELD_OFFERS_ORDER_ID is plain text)
  const path1 = `${encodeURIComponent(AIRTABLE_TABLE_OFFER_MSGS)}?filterByFormula=${encodeURIComponent(
    `{${FIELD_OFFERS_ORDER_ID}}='${orderRecId}'`
  )}`;
  let data = await airtableRequest("GET", path1);
  let rows = (data.records || []).map(r => ({
    channelId: r.fields?.[FIELD_OFFERS_CHANNEL_ID],
    messageId: r.fields?.[FIELD_OFFERS_MESSAGE_ID],
  })).filter(x => x.channelId && x.messageId);

  // If nothing, try linked-record case using ARRAYJOIN
  if (rows.length === 0) {
    const path2 = `${encodeURIComponent(AIRTABLE_TABLE_OFFER_MSGS)}?filterByFormula=${encodeURIComponent(
      `FIND('${orderRecId}', ARRAYJOIN({${FIELD_OFFERS_ORDER_ID}}))`
    )}`;
    try {
      data = await airtableRequest("GET", path2);
      rows = (data.records || []).map(r => ({
        channelId: r.fields?.[FIELD_OFFERS_CHANNEL_ID],
        messageId: r.fields?.[FIELD_OFFERS_MESSAGE_ID],
      })).filter(x => x.channelId && x.messageId);
    } catch {
      // swallow; table might not exist
    }
  }
  return rows;
}

/* =================== SALES CREATION & QUANTITY -= 1 =================== */
/**
 * Creates a Sales row and decrements Inventory.Quantity by 1.
 * - If Inventory.VAT Type == VAT0 AND seller is NL → write VAT21 in Sales
 * - Seller ID (linked) and SKU (linked) are read from Inventory's linked fields and
 *   written as [{id:"rec..."}].
 */
export async function createSaleAndDecrement({ inventoryId, orderRecId, finalPrice }) {
  // 1) Fetch inventory record
  const invRec = await airtableRequest("GET", `${encodeURIComponent(AIRTABLE_TABLE_INVENTORY)}/${inventoryId}`);
  const f = invRec.fields || {};

  // 2) Extract inbound values
  const productName = getText(f, FIELD_INV_PRODUCT_NAME) || "";
  const size        = getText(f, FIELD_INV_SIZE) || "";
  const brand       = getText(f, FIELD_INV_BRAND) || "";
  const vatTypeRaw  = getSingleSelectName(f, FIELD_INV_VAT_TYPE) || ""; // "Margin" | "VAT0" | "VAT21"
  const qty         = getNumber(f, FIELD_INV_QUANTITY) ?? 0;

  // Linked cells (can be ["rec..."], [{id:"rec..."}], or "rec...")
  const rawSellerLink = f[FIELD_INV_LINKED_SELLER];
  const rawSkuLink    = f[FIELD_INV_SKU_MASTER];

  // DEBUG what Airtable returned, so you can see exact shapes
  console.log("[sales] Inventory links", {
    inventoryId,
    [FIELD_INV_LINKED_SELLER]: rawSellerLink,
    [FIELD_INV_SKU_MASTER]: rawSkuLink
  });

  const sellerLinks = toLinks(rawSellerLink);
  const skuLinks    = toLinks(rawSkuLink);

  if (sellerLinks.length === 0 || skuLinks.length === 0) {
    const issues = [];
    if (sellerLinks.length === 0) issues.push(`Missing/invalid "${FIELD_INV_LINKED_SELLER}"`);
    if (skuLinks.length === 0)    issues.push(`Missing/invalid "${FIELD_INV_SKU_MASTER}"`);
    throw new Error(`Inventory ${inventoryId}: ${issues.join(" & ")}.`);
  }

  // 3) Determine Sales.VAT Type output
  // Business rule: seller always sells to your NL company
  // If inventory VAT type is VAT0, treat it as VAT21 in the Sales row.
  const vatTypeOut = (String(vatTypeRaw).toUpperCase() === "VAT0") ? "VAT21" : (vatTypeRaw || "Margin");

  // 4) Build Sales fields
  const saleFields = {
    [FIELD_SALE_PRODUCT_NAME]: productName || "",
    [FIELD_SALE_SIZE]:         size || "",
    [FIELD_SALE_BRAND]:        brand || "",
    [FIELD_SALE_FINAL_PRICE]:  round2(finalPrice),
    [FIELD_SALE_VAT_TYPE]:     { name: vatTypeOut },       // single select
    [FIELD_SALE_SELLER_ID]:    sellerLinks,                // [{id:"rec..."}]
    [FIELD_SALE_ORDER_NUMBER]: [{ id: orderRecId }],       // link to Orders
    [FIELD_SALE_SKU]:          skuLinks,                   // [{id:"rec..."}]
  };

  console.log("Creating Sale:", JSON.stringify(saleFields, null, 2));

  // 5) Create Sales row
  await airtableRequest("POST", encodeURIComponent(AIRTABLE_TABLE_SALES), { fields: saleFields });

  // 6) Decrement Inventory.Quantity by 1 (and optionally mark Sold? if hits zero)
  const newQty = Math.max(0, (qty || 0) - 1);
  const updateFields = { [FIELD_INV_QUANTITY]: newQty };
  if (newQty === 0 && FIELD_INV_SOLD) {
    // If you maintain "Sold?", set it true on zero
    updateFields[FIELD_INV_SOLD] = true;
  }

  await airtableRequest(
    "PATCH",
    `${encodeURIComponent(AIRTABLE_TABLE_INVENTORY)}/${inventoryId}`,
    { fields: updateFields }
  );

  console.log(`[sales] Created sale & decremented quantity. inv=${inventoryId} → qty ${qty} → ${newQty}`);
}
