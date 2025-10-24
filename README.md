# Consignment Discord Bot (stateless)

Receives Airtable payloads, posts interactive Discord embeds per seller, updates Airtable on confirm, and disables all other offers once matched. Buttons continue to work after bot restarts (stateless custom_id + Airtable message log).

## 1) Prereqs

- **Discord Application & Bot**
  - Get: Bot Token, App ID, Public Key
  - Invite bot to your server with permissions: Send Messages, Embed Links, Read Message History

- **Airtable**
  - Personal Access Token with read/write to your base
  - Base ID

- **Tables & Fields**
  - Inventory:
    - `Sold?` (checkbox)
    - `Sale Date` (date)
    - `Selling Price (Final)` (number)
  - Unfulfilled Orders Log:
    - `Fulfillment Status` (text or single-select; must accept `Matched`)
  - **Offer Messages** (new table):
    - `Order Record ID` (text)
    - `Seller ID` (text)
    - `Inventory Record ID` (text)
    - `Channel ID` (text)
    - `Message ID` (text)
    - `Offer Price` (number)

## 2) Configure environment

Copy `.env.example` values into Render **Environment Variables** (no .env file on Render).

## 3) Deploy

- Push this repo to GitHub.
- Render → New → Web Service → Connect repo
- Build: `npm install`
- Start: `npm start`
- Set environment variables
- Deploy

## 4) Discord interactions URL

Set your Discord Application → **Interactions Endpoint URL** to:
