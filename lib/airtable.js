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
  FIELD_INV_LINK_SKU_MASTER   = "SKU Master",     // linked to SKU Master (expects array of rec ids)
  FIELD_INV_LINKED_SELLER     = "Linked Seller",  // linked to Sellers Database (expects array of rec ids)

  // --- SALES FIELDS (as in your base)
  FIELD_SALE_PRODUCT_NAME     = "Product Name",
  FIELD_SALE_SKU_LINK         = "SKU",                 // linked -> expects ["rec..."]
  FIELD_SALE_SIZE             = "Size",
  FIELD_SALE_BRAND            = "Brand",
  FIELD_SALE_FINAL_PRICE      = "Final Selling Price", // number/currency
  FIELD_SALE_VAT_TYPE         = "VAT Type",            // single select -> expects the option name (string)
  FIELD_SALE_SELLER_LINK      = "Seller ID",           // linked -> expects ["rec..."]
  FIELD_SALE_ORDER_LINK       = "Order Number",        // linked -> expects ["rec..."]

  // --- OFFER MSG FIELDS (optional table)
  // We will try both "Order Record ID" (text) and (optionally) "Order" as an alt column name.
  FIELD_OFFERS_ORDER_ID       = "Order Record ID",
  FIELD_OFFERS_CHANNEL_ID     = "Channel ID",
  FIELD_OFFERS_MESSAGE_ID     = "Message ID",
  // Optional extras—if present in your table, we’ll write them too (ignored if missing):
  FIELD_OFFERS_SELLER_ID      = "Seller ID",
  FIELD_OFFERS_INV_ID         = "Inventory Record ID",
  FIELD_OFFERS_OFFER_PRICE    = "Offer Price",
} = process.env;

const AT_API = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}`;

/* -------------------- core request -------------------- */
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

/* -------------------- helpers -------------------- */
const toText = (val) => {
  if (!val) return null;
  if (Array.isArray(val)) {
    const parts = val
      .map((x) =>
        typeof x === "string" ? x : (x && typeof x.name === "string" ? x.name : null)
      )
      .filter(Boolean);
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

function uniqBy(arr, keyer) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyer(x);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(x);
    }
  }
  return out;
}

/* ======================================================================================
   OFFER MESSAGES (log + read)
   ====================================================================================== */

/**
 * Log a Discord message row so we can disable buttons later for *all* messages of an order.
 * Safe: if optional columns are missing in your table, Airtable ignores unknown fields.
 */
export async function logOfferMessage({
  orderRecId,
  sellerId,
  inventoryRecordId,
  channelId,
  messageId,
  offerPrice,
}) {
  try {
    const fields = {
      [FIELD_OFFERS_ORDER_ID]: orderRecId, // primary text column
      [FIELD_OFFERS_CHANNEL_ID]: channelId,
      [FIELD_OFFERS_MESSAGE_ID]: messageId,
    };

    // Optional extras (ignored if your Offer Messages table doesn't have them)
    if (FIELD_OFFERS_SELLER_ID) fields[FIELD_OFFERS_SELLER_ID] = sellerId ?? null;
    if (FIELD_OFFERS_INV_ID) fields[FIELD_OFFERS_INV_ID] = inventoryRecordId ?? null;
    if (FIELD_OFFERS_OFFER_PRICE)
      fields[FIELD_OFFERS_OFFER_PRICE] =
        typeof offerPrice === "number" ? round2(offerPrice) : null;

    await airtableRequest(
      "POST",
      encodeURIComponent(AIRTABLE_TABLE_OFFER_MSGS),
      { fields }
    );
  } catch (e) {
    console.warn("logOfferMessage warn:", e.message);
  }
}

/**
 * Fetch all logged messages for an Airtable order record id.
 * Tries multiple column names; if filters return nothing, falls back to scanning.
 */
export async function listOfferMessagesForOrder(orderRecId) {
  if (!orderRecId) return [];

  const tablePath = encodeURIComponent(AIRTABLE_TABLE_OFFER_MSGS);

  // Attempt 1: filter by primary order id column
  const tryFilter = async (col) => {
    if (!col) return [];
    const formula = `{${col}}='${orderRecId}'`;
    const data = await airtableRequest(
      "GET",
      `${tablePath}?filterByFormula=${encodeURIComponent(formula)}`
    );
    return Array.isArray(data.records) ? data.records : [];
  };

  let records = await tryFilter(FIELD_OFFERS_ORDER_ID);
  if (!records.length && FIELD_OFFERS_ORDER_ID_ALT) {
    records = await tryFilter(FIELD_OFFERS_ORDER_ID_ALT);
  }

  // Attempt 2: full-table scan fallback (handles any unexpected column naming)
  if (!records.length) {
    let offset;
    const all = [];
    do {
      const page = await airtableRequest(
        "GET",
        `${tablePath}?pageSize=100${offset ? `&offset=${offset}` : ""}`
      );
      if (Array.isArray(page.records)) all.push(...page.records);
      offset = page.offset;
    } while (offset);

    const matches = all.filter((r) => {
      const f = r.fields || {};
      const a = f[FIELD_OFFERS_ORDER_ID];
      const b = FIELD_OFFERS_ORDER_ID_ALT ? f[FIELD_OFFERS_ORDER_ID_ALT] : undefined;
      return a === orderRecId || b === orderRecId;
    });
    records = matches;
  }

  const pairs = records
    .map((r) => ({
      channelId: r.fields?.[FIELD_OFFERS_CHANNEL_ID],
      messageId: r.fields?.[FIELD_OFFERS_MESSAGE_ID],
    }))
    .filter((x) => x.channelId && x.messageId);

  // De-dup just in case
  return uniqBy(pairs, (p) => `${p.channelId}:${p.messageId}`);
}

/* ======================================================================================
   SALES CREATION + INVENTORY DECREMENT
   ====================================================================================== */

/**
 * Create a Sales row with linked fields + decrement Inventory.Quantity by 1.
 * - Uses Inventory VAT type only to decide the Sales VAT: VAT0 → VAT21 (buyer is NL).
 * - Does NOT change VAT on the Inventory record.
 */
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
  const vatTypeName  = (toText(f[FIELD_INV_VAT_TYPE]) || "").toUpperCase(); // "MARGIN"|"VAT0"|"VAT21"

  // Linked record IDs
  const skuLinkId     = getFirstLinkedId(f[FIELD_INV_LINK_SKU_MASTER]);
  const sellerLinkId  = getFirstLinkedId(f[FIELD_INV_LINKED_SELLER]);

  if (!sellerLinkId) {
    throw new Error(`Inventory ${inventoryId}: Linked Seller field empty or not a linked record.`);
  }
  if (!skuLinkId) {
    throw new Error(`Inventory ${inventoryId}: SKU Master field empty or not a linked record.`);
  }

  // Sales VAT logic (buyer is NL): if seller's inventory VAT is VAT0, store VAT21 on the Sale
  const vatTypeOut = vatTypeName === "VAT0" ? "VAT21" : (vatTypeName || "Margin");

  // 2) Create Sales row
  const saleFields = {
    [FIELD_SALE_PRODUCT_NAME]: productName,
    [FIELD_SALE_SIZE]:         size,
    [FIELD_SALE_BRAND]:        brand,
    [FIELD_SALE_FINAL_PRICE]:  round2(finalPrice),
    [FIELD_SALE_VAT_TYPE]:     vatTypeOut,     // single select option name
    [FIELD_SALE_SKU_LINK]:     [skuLinkId],    // linked record ids
    [FIELD_SALE_SELLER_LINK]:  [sellerLinkId],
    [FIELD_SALE_ORDER_LINK]:   orderRecId ? [orderRecId] : undefined,
  };

  console.log("Creating Sale:", JSON.stringify(saleFields, null, 2));

  await airtableRequest(
    "POST",
    encodeURIComponent(AIRTABLE_TABLE_SALES),
    { fields: saleFields }
  );

  // 3) Decrement Inventory.Quantity by 1 (and nothing else)
  const currentQty = toNumber(f[FIELD_INV_QTY]) ?? 0;
  const newQty = Math.max(0, currentQty - 1);

  await airtableRequest(
    "PATCH",
    `${encodeURIComponent(AIRTABLE_TABLE_INVENTORY)}/${inventoryId}`,
    { fields: { [FIELD_INV_QTY]: newQty } }
  );

  console.log(`✅ Sale created + Quantity decremented → newQty: ${newQty}`);
}
