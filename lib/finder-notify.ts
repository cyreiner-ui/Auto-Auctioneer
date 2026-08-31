import nodemailer from "nodemailer";

export type NotifyKind = "pocket_knife" | "carving_set" | "gaucho_knife" | "mate_gourd";

export type NotifiableFinderItem = {
  ebay_item_id: string;
  title: string;
  ebay_url: string;
  image_url: string | null;
  item_price: number;
  shipping_cost: number | null;
  total_cost: number | null;
  cost_per_knife: number | null;
  knife_count: number | null;
  carving_piece_count?: number | null;
  carving_has_case?: boolean | null;
  carving_carbon_steel?: boolean | null;
  carving_handle_material?: "stag" | "ivory" | "other" | null;
  gaucho_match_confidence?: number | null;
  gaucho_maker_match?: boolean | null;
  gaucho_match_notes?: string | null;
  mate_gourd_match_confidence?: number | null;
  mate_gourd_match_notes?: string | null;
};

const usd = (value: number | null) => (value == null ? "—" : Number(value).toLocaleString("en-US", { style: "currency", currency: "USD" }));
const escapeHtml = (value: string) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] as string));
const dealLabel = (kind: NotifyKind) => (kind === "carving_set" ? "carving set" : kind === "gaucho_knife" ? "gaucho knife" : kind === "mate_gourd" ? "maté gourd" : "pocket knife");

// Same palette as the finder dashboard (see app/globals.css's :root and .finder-card rules) so the
// alert email reads as the same product rather than a generic transactional email.
const COLORS = { bg: "#101211", panel: "#1a1d1c", line: "#3a403d", ivory: "#f1eadb", muted: "#a9aaa0", lime: "#b8c58b", copper: "#c4774e" };

// The app has one deployed URL (there's no per-request origin available from a background
// finder run), so this mirrors the production URL the Cloudflare scheduler already hardcodes
// (scheduler/wrangler.jsonc's BID_RUN_URL/FINDER_TICK_URL) as a last-resort fallback, while still
// letting APP_BASE_URL (or Vercel's own auto-populated VERCEL_URL/VERCEL_PROJECT_PRODUCTION_URL)
// override it for a custom domain or a non-production deployment.
function appBaseUrl() {
  const configured = process.env.APP_BASE_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  const vercelUrl = (process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL)?.trim();
  if (vercelUrl) return `https://${vercelUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  return "https://auto-auctioneer-cyreiner.vercel.app";
}

// The dashboard is a single route with an in-page kind switcher (see FinderDashboard.tsx's
// KIND_LABEL/dropdown) rather than one URL per category, so every kind links here alike.
const dashboardUrl = () => `${appBaseUrl()}/staff/finder`;

const MAX_EMAIL_ITEMS = 10;

function itemBadges(item: NotifiableFinderItem, kind: NotifyKind): string[] {
  if (kind === "carving_set") {
    const pieces = item.carving_piece_count ?? 1;
    const badges = [`${pieces} piece${pieces === 1 ? "" : "s"}`];
    if (item.carving_has_case) badges.push("cased");
    if (item.carving_carbon_steel) badges.push("carbon steel");
    if (item.carving_handle_material === "stag") badges.push("stag handle");
    else if (item.carving_handle_material === "ivory") badges.push("ivory handle");
    return badges;
  }
  if (kind === "gaucho_knife") {
    const badges: string[] = [];
    if (item.gaucho_match_confidence != null) badges.push(`${Math.round(Number(item.gaucho_match_confidence) * 100)}% match confidence`);
    if (item.gaucho_maker_match === true) badges.push("maker markings match");
    else if (item.gaucho_maker_match === false) badges.push("maker markings don't match");
    return badges;
  }
  if (kind === "mate_gourd") {
    const badges: string[] = [];
    if (item.mate_gourd_match_confidence != null) badges.push(`${Math.round(Number(item.mate_gourd_match_confidence) * 100)}% match confidence`);
    return badges;
  }
  return [item.knife_count != null ? `${item.knife_count} knives` : "Knife count unknown"];
}

function priceLine(item: NotifiableFinderItem) {
  let line = usd(item.item_price);
  if (item.shipping_cost != null) line += ` + ${usd(item.shipping_cost)} shipping`;
  if (item.total_cost != null) line += ` = ${usd(item.total_cost)} total`;
  return line;
}

function renderItemCard(item: NotifiableFinderItem, kind: NotifyKind) {
  const title = escapeHtml(item.title);
  const badgesHtml = itemBadges(item, kind)
    .map((badge) => `<span style="display:inline-block;padding:3px 5px;margin:0 4px 4px 0;border:1px solid ${COLORS.line};color:${COLORS.lime};font-size:8px;letter-spacing:.06em;text-transform:uppercase;">${escapeHtml(badge)}</span>`)
    .join("");
  const image = item.image_url
    ? `<img src="${escapeHtml(item.image_url)}" width="260" height="130" alt="${title}" style="display:block;width:100%;height:130px;object-fit:cover;background:${COLORS.bg};border:0;" />`
    : `<div style="height:130px;background:${COLORS.bg};color:${COLORS.muted};font-size:11px;text-align:center;line-height:130px;">No image</div>`;
  const unitPrice = kind === "pocket_knife" && item.cost_per_knife != null
    ? `<p style="margin:8px 0;color:${COLORS.lime};font:15px Georgia,serif;">${usd(item.cost_per_knife)}/knife</p>`
    : "";
  const matchNotes = (kind === "gaucho_knife" && item.gaucho_match_notes) || (kind === "mate_gourd" && item.mate_gourd_match_notes) || "";
  const gauchoNotes = matchNotes
    ? `<p style="margin:6px 0 0;color:${COLORS.muted};font-size:9px;line-height:1.4;">${escapeHtml(matchNotes)}</p>`
    : "";
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.panel};border:1px solid ${COLORS.line};">
      <tr><td>${image}</td></tr>
      <tr><td style="padding:10px;">
        <div>${badgesHtml}</div>
        <a href="${escapeHtml(item.ebay_url)}" style="display:block;margin:8px 0;color:${COLORS.ivory};font:600 13px Georgia,serif;text-decoration:none;">${title}</a>
        <p style="margin:0;color:${COLORS.muted};font-size:9px;">${priceLine(item)}</p>
        ${unitPrice}
        ${gauchoNotes}
        <a href="${escapeHtml(item.ebay_url)}" style="display:inline-block;margin-top:8px;color:${COLORS.lime};font-size:10px;text-decoration:none;">View on eBay →</a>
      </td></tr>
    </table>`;
}

function renderDashboardButton() {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;">
      <tr><td align="center">
        <a href="${dashboardUrl()}" style="display:inline-block;padding:12px 32px;background:${COLORS.copper};color:#171513;font:700 13px Georgia,serif;text-decoration:none;">See more →</a>
      </td></tr>
    </table>`;
}

// Table-based centering (align="center" on the outer <td>, not just CSS margin:auto) because
// Outlook and some webmail clients strip margin from block-level divs — this is the standard
// email-HTML way to reliably center a fixed-width panel. The .eaf-card media-query override
// collapses the 2-column item grid to one column below 480px, since most staff read this on a
// phone, not a desktop inbox.
function renderEmailShell(heading: string, body: string) {
  return `
    <style>@media only screen and (max-width:480px){.eaf-panel{width:100% !important;}.eaf-card{display:block !important;width:100% !important;padding:6px 0 !important;}}</style>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.bg};font-family:Arial,Helvetica,sans-serif;">
      <tr><td align="center" style="padding:24px 12px;">
        <table role="presentation" width="640" cellpadding="0" cellspacing="0" class="eaf-panel" style="width:640px;max-width:640px;background:${COLORS.panel};border:1px solid ${COLORS.line};">
          <tr><td style="padding:20px;">
            <p style="margin:0 0 4px;color:${COLORS.muted};font-size:10px;letter-spacing:.16em;text-transform:uppercase;text-align:center;">eBay Discovery</p>
            <h1 style="margin:0 0 16px;color:${COLORS.ivory};font:600 20px Georgia,serif;text-align:center;">${escapeHtml(heading)}</h1>
            ${body}
            ${renderDashboardButton()}
          </td></tr>
        </table>
      </td></tr>
    </table>`;
}

function renderEmailHtml(items: NotifiableFinderItem[], kind: NotifyKind) {
  const shown = items.slice(0, MAX_EMAIL_ITEMS);
  const remaining = items.length - shown.length;
  const cardRows: string[] = [];
  for (let index = 0; index < shown.length; index += 2) {
    const pair = shown.slice(index, index + 2);
    const cells = pair.map((item) => `<td class="eaf-card" width="50%" style="padding:6px;vertical-align:top;">${renderItemCard(item, kind)}</td>`).join("");
    const padding = pair.length < 2 ? `<td class="eaf-card" width="50%" style="padding:6px;"></td>` : "";
    cardRows.push(`<tr>${cells}${padding}</tr>`);
  }
  const grid = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tbody>${cardRows.join("")}</tbody></table>`;
  const moreNote = remaining > 0
    ? `<p style="margin:12px 0 0;color:${COLORS.muted};font-size:11px;text-align:center;">+${remaining} more waiting in the finder.</p>`
    : "";
  const heading = `${items.length} new ${dealLabel(kind)} deal${items.length === 1 ? "" : "s"} found`;
  return renderEmailShell(heading, `${grid}${moreNote}`);
}

function transportConfig() {
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const password = process.env.SMTP_PASSWORD?.trim();
  if (!host || !user || !password) return null;
  const port = Number(process.env.SMTP_PORT || 587);
  return { host, port, secure: port === 465, auth: { user, pass: password } };
}

// Names only, never values — lets the "not configured" message say exactly which of the three
// SMTP_* vars this specific deployment doesn't see, instead of leaving staff to guess after
// Vercel's dashboard shows them as present (a scoping/typo/stale-deployment mismatch that a
// blanket "not configured" message can't distinguish from actually never having been set).
function missingSmtpEnvKeys() {
  return ["SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD"].filter((key) => !process.env[key]?.trim());
}

function notConfiguredMessage() {
  const missing = missingSmtpEnvKeys();
  const detail = missing.length ? ` Missing/empty on this deployment: ${missing.join(", ")}.` : "";
  return `Email alerts are not configured (SMTP_HOST/SMTP_USER/SMTP_PASSWORD, and at least one recipient in finder notification settings).${detail}`;
}

export async function sendQualifiedItemsEmail(items: NotifiableFinderItem[], recipients: string[], kind: NotifyKind = "pocket_knife") {
  if (!items.length) return { ok: true, skipped: true as const };
  const transportOptions = transportConfig();
  const from = process.env.FINDER_ALERT_EMAIL_FROM?.trim() || transportOptions?.auth.user;
  const to = recipients;
  if (!transportOptions || !from || !to.length) return { ok: false, skipped: true as const, message: notConfiguredMessage() };
  try {
    const transporter = nodemailer.createTransport(transportOptions);
    await transporter.sendMail({
      from,
      to,
      subject: `${items.length} new ${dealLabel(kind)} deal${items.length === 1 ? "" : "s"} found`,
      html: renderEmailHtml(items, kind),
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Sending the alert email failed." };
  }
}

export async function sendTestEmail(recipients: string[]) {
  const transportOptions = transportConfig();
  const from = process.env.FINDER_ALERT_EMAIL_FROM?.trim() || transportOptions?.auth.user;
  const to = recipients;
  if (!transportOptions || !from || !to.length) return { ok: false, skipped: true as const, message: notConfiguredMessage() };
  try {
    const transporter = nodemailer.createTransport(transportOptions);
    await transporter.sendMail({
      from,
      to,
      subject: "Knife Auctions test alert",
      html: "<p>This is a test email from the eBay deal finder's notification settings. If you received this, alert emails are working.</p>",
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Sending the test email failed." };
  }
}

export type FinderRunSummaryCounts = { total: number; auctionCount: number; fixedPriceCount: number };

export async function sendRunSummaryEmail(counts: FinderRunSummaryCounts, recipients: string[], kind: NotifyKind = "pocket_knife") {
  if (!counts.total) return { ok: true, skipped: true as const };
  const transportOptions = transportConfig();
  const from = process.env.FINDER_ALERT_EMAIL_FROM?.trim() || transportOptions?.auth.user;
  const to = recipients;
  if (!transportOptions || !from || !to.length) return { ok: false, skipped: true as const, message: notConfiguredMessage() };
  try {
    const transporter = nodemailer.createTransport(transportOptions);
    await transporter.sendMail({
      from,
      to,
      subject: `${counts.total} new ${dealLabel(kind)} deal${counts.total === 1 ? "" : "s"} found`,
      html: renderEmailShell(
        `${counts.total} new ${dealLabel(kind)} deal${counts.total === 1 ? "" : "s"} found`,
        `<p style="margin:0;color:${COLORS.muted};font-size:13px;">${counts.auctionCount} auction${counts.auctionCount === 1 ? "" : "s"}, ${counts.fixedPriceCount} fixed-price listing${counts.fixedPriceCount === 1 ? "" : "s"}.</p>`,
      ),
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Sending the alert email failed." };
  }
}
